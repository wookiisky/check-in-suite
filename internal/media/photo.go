package media

import (
	"encoding/binary"
	"image"
	"image/jpeg"
	"image/png"
	"io"
	"os"

	"github.com/disintegration/imaging"
	"github.com/wookiisky/check-in-suite/internal/core"
)

// photo checks pixels before decoding, applies EXIF orientation and writes metadata-free pixels.
func (s *Service) photo(path string, output io.Writer) (Media, error) {
	f, err := os.Open(path)
	if err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	defer f.Close()
	configuration, format, err := image.DecodeConfig(f)
	if err != nil || (format != "jpeg" && format != "png") || configuration.Width < 1 || configuration.Height < 1 {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	if int64(configuration.Width) > s.Config.Limits.PhotoPixelsMax/int64(configuration.Height) {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	if format == "png" {
		if _, err := f.Seek(0, io.SeekStart); err != nil {
			return Media{}, err
		}
		if err := singleFramePNG(f); err != nil {
			return Media{}, err
		}
	}
	if _, err := f.Seek(0, io.SeekStart); err != nil {
		return Media{}, err
	}
	pixels, err := imaging.Decode(f, imaging.AutoOrientation(true))
	if err != nil {
		return Media{}, core.Fail(422, "INVALID_MEDIA")
	}
	if pixels.Bounds().Dx() > s.Config.Limits.PhotoEdgeMax || pixels.Bounds().Dy() > s.Config.Limits.PhotoEdgeMax {
		pixels = imaging.Fit(pixels, s.Config.Limits.PhotoEdgeMax, s.Config.Limits.PhotoEdgeMax, imaging.Lanczos)
	}
	width, height := pixels.Bounds().Dx(), pixels.Bounds().Dy()
	result := Media{Width: &width, Height: &height}
	if format == "jpeg" {
		result.MIMEType = "image/jpeg"
		err = jpeg.Encode(output, pixels, &jpeg.Options{Quality: 85})
	} else {
		result.MIMEType = "image/png"
		err = png.Encode(output, pixels)
	}
	if err != nil {
		return Media{}, core.Fail(503, "STORAGE_UNAVAILABLE")
	}
	return result, nil
}

// singleFramePNG rejects APNG chunks instead of silently keeping only an animation's first frame.
func singleFramePNG(reader io.Reader) error {
	var signature [8]byte
	if _, err := io.ReadFull(reader, signature[:]); err != nil {
		return core.Fail(422, "INVALID_MEDIA")
	}
	for {
		var header [8]byte
		if _, err := io.ReadFull(reader, header[:]); err != nil {
			return core.Fail(422, "INVALID_MEDIA")
		}
		length := int64(binary.BigEndian.Uint32(header[:4]))
		kind := string(header[4:])
		if kind == "acTL" {
			return core.Fail(422, "INVALID_MEDIA")
		}
		if _, err := io.CopyN(io.Discard, reader, length+4); err != nil {
			return core.Fail(422, "INVALID_MEDIA")
		}
		if kind == "IEND" {
			return nil
		}
	}
}
