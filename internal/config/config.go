// Package config loads the settings required by the local application skeleton.
package config

import (
	"errors"
	"fmt"
	"io"
	"net"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"go.yaml.in/yaml/v3"
)

// Config contains explicit startup settings; file paths are relative to the working directory.
type Config struct {
	ListenAddress     string         `yaml:"listen_address"`      // HTTP address for the Go server.
	DatabasePath      string         `yaml:"database_path"`       // Local SQLite database file.
	MediaDirectory    string         `yaml:"media_directory"`     // Private attachment directory.
	TempDirectory     string         `yaml:"temp_directory"`      // Private temporary-upload directory.
	SQLiteBusyTimeout time.Duration  `yaml:"sqlite_busy_timeout"` // Maximum wait for a database writer.
	HTTPTimeout       time.Duration  `yaml:"http_timeout"`        // Deadline for current JSON and health requests.
	FFprobePath       string         `yaml:"ffprobe_path"`        // Executable path or PATH-resolved ffprobe name.
	MediaProbeTimeout time.Duration  `yaml:"media_probe_timeout"` // Deadline for the ffprobe dependency check.
	Location          *time.Location `yaml:"-"`                   // Fixed business timezone bundled with the binary.
}

// Load rejects unknown or missing settings before constructing application dependencies.
func Load(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("read configuration: %w", err)
	}
	defer file.Close()
	var cfg Config
	decoder := yaml.NewDecoder(file)
	decoder.KnownFields(true)
	if err := decoder.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("decode configuration: %w", err)
	}
	var extra any
	if err := decoder.Decode(&extra); !errors.Is(err, io.EOF) {
		return Config{}, errors.New("configuration must contain exactly one YAML document")
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	cfg.Location, err = time.LoadLocation("Asia/Taipei")
	if err != nil {
		return Config{}, fmt.Errorf("load business timezone: %w", err)
	}
	return cfg, nil
}

// validate checks the settings consumed by this development skeleton.
func (cfg Config) validate() error {
	for name, value := range map[string]string{
		"listen_address": cfg.ListenAddress, "database_path": cfg.DatabasePath,
		"media_directory": cfg.MediaDirectory, "temp_directory": cfg.TempDirectory, "ffprobe_path": cfg.FFprobePath,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	_, port, err := net.SplitHostPort(cfg.ListenAddress)
	if err != nil {
		return fmt.Errorf("listen_address must be host:port: %w", err)
	}
	portNumber, err := strconv.Atoi(port)
	if err != nil || portNumber < 1 || portNumber > 65535 {
		return errors.New("listen_address port must be between 1 and 65535")
	}
	if cfg.SQLiteBusyTimeout < time.Millisecond || cfg.HTTPTimeout <= 0 || cfg.MediaProbeTimeout <= 0 {
		return errors.New("timeouts must be positive; sqlite_busy_timeout must be at least 1ms")
	}
	if cfg.HTTPTimeout <= cfg.SQLiteBusyTimeout || cfg.HTTPTimeout <= cfg.MediaProbeTimeout {
		return errors.New("http_timeout must exceed sqlite_busy_timeout and media_probe_timeout")
	}
	return nil
}
