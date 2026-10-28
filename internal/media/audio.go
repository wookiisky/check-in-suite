package media

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"io"
	"math"
	"os"
	"os/exec"
	"strconv"
	"strings"
	"time"

	"github.com/wookiisky/check-in-suite/internal/core"
)

// probeResult contains only the format and stream evidence needed for acceptance.
type probeResult struct {
	Streams []struct {
		CodecType  string `json:"codec_type"`  // Must be exactly one audio stream.
		CodecName  string `json:"codec_name"`  // Opus or AAC according to its container.
		SampleRate string `json:"sample_rate"` // Samples per second reported by the decoder.
	} `json:"streams"` // Actual streams discovered by ffprobe.
	Frames []struct {
		Samples   int64  `json:"nb_samples"` // Decoded audible samples, excluding codec padding.
		Timestamp string `json:"pts_time"`   // Presentation time used to detect excessive timeline gaps.
	} `json:"frames"` // Actual decoded frames, with a bounded aggregate process output.
	Format struct {
		Name string `json:"format_name"` // Probe-selected container family.
	} `json:"format"` // Container properties; client metadata is ignored.
}

// boundedOutput prevents a malformed probe result or diagnostic stream from allocating indefinitely.
type boundedOutput struct {
	bytes.Buffer     // Retained output up to the fixed cap.
	Limit        int // Maximum allowed bytes.
}

// Write rejects overlong process output and causes exec to report failure.
func (b *boundedOutput) Write(value []byte) (int, error) {
	if len(value) > b.Limit-b.Len() {
		return 0, errors.New("media probe output exceeded bound")
	}
	return b.Buffer.Write(value)
}

// audio accepts one supported audio stream and copies the original verified container without transcoding.
func (s *Service) audio(ctx context.Context, path string, output io.Writer) (Media, error) {
	probeContext, cancel := context.WithTimeout(ctx, s.Config.MediaProbeTimeout)
	defer cancel()
	command := exec.CommandContext(probeContext, s.Config.FFprobePath, "-v", "error", "-show_frames", "-show_entries", "format=format_name:stream=codec_type,codec_name,sample_rate:frame=nb_samples,pts_time", "-of", "json", "-i", path)
	stdout := &boundedOutput{Limit: 4 << 20}
	stderr := &boundedOutput{Limit: 16 * 1024}
	command.Stdout = stdout
	command.Stderr = stderr
	if err := command.Run(); err != nil {
		if ctx.Err() != nil {
			return Media{}, ctx.Err()
		}
		var executableError *exec.Error
		var pathError *os.PathError
		if errors.As(err, &executableError) || errors.As(err, &pathError) {
			return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
		}
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	if stderr.Len() != 0 {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	var probe probeResult
	if err := json.Unmarshal(stdout.Bytes(), &probe); err != nil || len(probe.Streams) != 1 || probe.Streams[0].CodecType != "audio" {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	stream := probe.Streams[0]
	var contentType string
	switch {
	case probe.Format.Name == "matroska,webm" && stream.CodecName == "opus":
		contentType = "audio/webm"
	case probe.Format.Name == "ogg" && stream.CodecName == "opus":
		contentType = "audio/ogg"
	case strings.Contains(","+probe.Format.Name+",", ",mp4,") && stream.CodecName == "aac":
		contentType = "audio/mp4"
	default:
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	rate, err := strconv.ParseInt(stream.SampleRate, 10, 64)
	if err != nil || rate <= 0 || rate > core.MaxInteger/(int64(s.Config.Limits.AudioSecondsMax)*1000) || len(probe.Frames) == 0 {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	maximumSamples := int64(s.Config.Limits.AudioSecondsMax) * rate
	var samples int64
	start, end := math.Inf(1), math.Inf(-1)
	for _, frame := range probe.Frames {
		if frame.Samples <= 0 || frame.Samples > maximumSamples-samples {
			return Media{}, core.Fail(422, "INVALID_MEDIA")
		}
		samples += frame.Samples
		instant, err := strconv.ParseFloat(frame.Timestamp, 64)
		if err != nil || math.IsNaN(instant) || math.IsInf(instant, 0) {
			return Media{}, core.Fail(422, "INVALID_MEDIA")
		}
		start = math.Min(start, instant)
		end = math.Max(end, instant+float64(frame.Samples)/float64(rate))
	}
	// WebM timestamps round to milliseconds; decoded samples still enforce the exact 60-second cap.
	if end-start > float64(s.Config.Limits.AudioSecondsMax)+time.Millisecond.Seconds()+0.000001 {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	f, err := os.Open(path)
	if err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	defer f.Close()
	if _, err := copyContext(ctx, output, f, s.Config.Limits.AudioBytesMax); err != nil {
		return Media{}, err
	}
	milliseconds := (samples*1000 + rate - 1) / rate
	return Media{MIMEType: contentType, DurationMS: &milliseconds}, nil
}
