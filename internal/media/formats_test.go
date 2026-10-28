package media

import (
	"bytes"
	"context"
	"encoding/binary"
	"image"
	"image/color"
	"image/jpeg"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"testing"
)

// TestJPEGOrientation checks all EXIF rotations and mirrors against known corner positions.
func TestJPEGOrientation(t *testing.T) {
	s, p := mediaFixture(t)
	colors := []color.NRGBA{{240, 20, 20, 255}, {20, 220, 20, 255}, {20, 20, 240, 255}, {230, 220, 20, 255}}
	expected := [][4]int{{0, 1, 2, 3}, {1, 0, 3, 2}, {3, 2, 1, 0}, {2, 3, 0, 1}, {0, 2, 1, 3}, {2, 0, 3, 1}, {3, 1, 2, 0}, {1, 3, 0, 2}}
	for orientation := 1; orientation <= 8; orientation++ {
		data := orientedJPEG(t, orientation, colors)
		result, err := s.Upload(context.Background(), p, "photo", bytes.NewReader(data))
		if err != nil {
			t.Fatal(err)
		}
		width, height := 40, 20
		if orientation >= 5 {
			width, height = 20, 40
		}
		if *result.Width != width || *result.Height != height {
			t.Fatalf("orientation %d: %dx%d", orientation, *result.Width, *result.Height)
		}
		_, file, err := s.Open(context.Background(), p, result.ID)
		if err != nil {
			t.Fatal(err)
		}
		encoded, err := io.ReadAll(file)
		file.Close()
		if err != nil {
			t.Fatal(err)
		}
		if bytes.Contains(encoded, []byte("Exif")) {
			t.Fatal("original metadata retained")
		}
		pixels, _, err := image.Decode(bytes.NewReader(encoded))
		if err != nil {
			t.Fatal(err)
		}
		points := [][2]int{{width / 4, height / 4}, {width * 3 / 4, height / 4}, {width / 4, height * 3 / 4}, {width * 3 / 4, height * 3 / 4}}
		for corner, point := range points {
			got := color.NRGBAModel.Convert(pixels.At(point[0], point[1])).(color.NRGBA)
			want := colors[expected[orientation-1][corner]]
			if abs(int(got.R)-int(want.R)) > 40 || abs(int(got.G)-int(want.G)) > 40 || abs(int(got.B)-int(want.B)) > 40 {
				t.Fatalf("orientation %d corner %d: got=%v want=%v", orientation, corner, got, want)
			}
		}
	}
}

// TestRealAudioContainers verifies the configured format set using real ffmpeg and ffprobe bytes.
func TestRealAudioContainers(t *testing.T) {
	s, p := mediaFixture(t)
	for _, fixture := range []struct{ format, codec, mime string }{{"webm", "libopus", "audio/webm"}, {"ogg", "libopus", "audio/ogg"}, {"mp4", "aac", "audio/mp4"}} {
		data := audioFixture(t, fixture.format, fixture.codec, "0.2")
		result, err := s.Upload(context.Background(), p, "audio", bytes.NewReader(data))
		if err != nil {
			t.Fatalf("%s: %v", fixture.format, err)
		}
		if result.MIMEType != fixture.mime || result.DurationMS == nil || *result.DurationMS < 100 || *result.DurationMS > 1000 || result.Width != nil {
			t.Fatalf("%+v", result)
		}
	}
	_, err := s.Upload(context.Background(), p, "audio", bytes.NewReader(audioFixture(t, "webm", "libopus", "60.1")))
	mediaCode(t, err, "INVALID_MEDIA")
	_, err = s.Upload(context.Background(), p, "audio", bytes.NewReader(audioFixture(t, "wav", "pcm_s16le", "0.2")))
	mediaCode(t, err, "INVALID_MEDIA")
	_, err = s.Upload(context.Background(), p, "audio", bytes.NewReader(pngFixture(t, 2, 2)))
	mediaCode(t, err, "INVALID_MEDIA")
}

// TestSixtySecondsIgnoresCodecPadding checks audible duration at the exact permitted boundary.
func TestSixtySecondsIgnoresCodecPadding(t *testing.T) {
	s, p := mediaFixture(t)
	for _, fixture := range []struct{ format, codec string }{{"webm", "libopus"}, {"ogg", "libopus"}, {"mp4", "aac"}} {
		result, err := s.Upload(context.Background(), p, "audio", bytes.NewReader(audioFixture(t, fixture.format, fixture.codec, "60")))
		if err != nil || result.DurationMS == nil || *result.DurationMS != 60000 {
			t.Fatalf("%s exact boundary: %+v %v", fixture.format, result, err)
		}
	}
}

// TestBrowserStreamingRecording accepts real MediaRecorder output even when container duration is absent.
func TestBrowserStreamingRecording(t *testing.T) {
	s, p := mediaFixture(t)
	data, err := os.ReadFile("testdata/chromium-recording.webm")
	if err != nil {
		t.Fatal(err)
	}
	result, err := s.Upload(context.Background(), p, "audio", bytes.NewReader(data))
	if err != nil || result.DurationMS == nil || *result.DurationMS != 1200 || result.MIMEType != "audio/webm" {
		t.Fatalf("streaming browser recording: %+v %v", result, err)
	}
}

// orientedJPEG embeds one standard little-endian EXIF orientation tag in a four-color fixture.
func orientedJPEG(t *testing.T, orientation int, colors []color.NRGBA) []byte {
	t.Helper()
	pixels := image.NewNRGBA(image.Rect(0, 0, 40, 20))
	for y := 0; y < 20; y++ {
		for x := 0; x < 40; x++ {
			index := 0
			if x >= 20 {
				index++
			}
			if y >= 10 {
				index += 2
			}
			pixels.SetNRGBA(x, y, colors[index])
		}
	}
	var base bytes.Buffer
	if err := jpeg.Encode(&base, pixels, &jpeg.Options{Quality: 100}); err != nil {
		t.Fatal(err)
	}
	payload := []byte{'E', 'x', 'i', 'f', 0, 0, 'I', 'I', 42, 0, 8, 0, 0, 0, 1, 0, 0x12, 1, 3, 0, 1, 0, 0, 0, byte(orientation), 0, 0, 0, 0, 0, 0, 0}
	header := []byte{0xff, 0xe1, 0, 0}
	binary.BigEndian.PutUint16(header[2:], uint16(len(payload)+2))
	result := append([]byte{}, base.Bytes()[:2]...)
	result = append(result, header...)
	result = append(result, payload...)
	return append(result, base.Bytes()[2:]...)
}

// audioFixture invokes the installed encoder to avoid treating mocked probe output as format evidence.
func audioFixture(t *testing.T, format, codec, duration string) []byte {
	t.Helper()
	path := filepath.Join(t.TempDir(), "recording."+format)
	command := exec.Command("ffmpeg", "-v", "error", "-f", "lavfi", "-i", "sine=frequency=440:sample_rate=48000", "-t", duration, "-c:a", codec, "-f", format, path)
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("ffmpeg: %v %s", err, output)
	}
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// abs compares decoded colors with a tolerance for JPEG's lossy encoding.
func abs(value int) int {
	if value < 0 {
		return -value
	}
	return value
}
