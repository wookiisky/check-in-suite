// Package config loads the settings required by the local application skeleton.
package config

import (
	"errors"
	"fmt"
	"io"
	"net"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
	_ "time/tzdata"

	"go.yaml.in/yaml/v3"
)

// Config contains explicit startup settings; file paths are relative to the working directory.
type Config struct {
	PublicOrigin         string         `yaml:"public_origin"`          // Exact public origin trusted for state-changing browser requests.
	StaticDirectory      string         `yaml:"static_directory"`       // Built SPA files, never private data.
	AssetsDirectory      string         `yaml:"assets_directory"`       // Persistent versioned artwork directory.
	SessionTTL           time.Duration  `yaml:"session_ttl"`            // Fixed login session lifetime.
	ManagementTTL        time.Duration  `yaml:"management_ttl"`         // Fixed management unlock lifetime.
	UploadTimeout        time.Duration  `yaml:"upload_timeout"`         // Maximum upload lifetime.
	MediaOrphanTTL       time.Duration  `yaml:"media_orphan_ttl"`       // Grace period before unreferenced files are cleaned.
	MediaCleanupInterval time.Duration  `yaml:"media_cleanup_interval"` // Interval between media cleanup attempts.
	Limits               Limits         `yaml:"limits"`                 // Confirmed input limits also returned by session reads.
	ListenAddress        string         `yaml:"listen_address"`         // HTTP address for the Go server.
	DatabasePath         string         `yaml:"database_path"`          // Local SQLite database file.
	MediaDirectory       string         `yaml:"media_directory"`        // Private attachment directory.
	TempDirectory        string         `yaml:"temp_directory"`         // Private temporary-upload directory.
	SQLiteBusyTimeout    time.Duration  `yaml:"sqlite_busy_timeout"`    // Maximum wait for a database writer.
	HTTPTimeout          time.Duration  `yaml:"http_timeout"`           // Deadline for current JSON and health requests.
	FFprobePath          string         `yaml:"ffprobe_path"`           // Executable path or PATH-resolved ffprobe name.
	MediaProbeTimeout    time.Duration  `yaml:"media_probe_timeout"`    // Deadline for the ffprobe dependency check.
	Location             *time.Location `yaml:"-"`                      // Fixed business timezone bundled with the binary.
}

// Load rejects unknown or missing settings before constructing application dependencies.
func Load(path string) (Config, error) {
	file, err := os.Open(path)
	if err != nil {
		return Config{}, fmt.Errorf("read configuration: %w", err)
	}
	defer file.Close()
	cfg := Defaults()
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
	origin, err := url.Parse(cfg.PublicOrigin)
	if err != nil || origin.Host == "" || (origin.Scheme != "http" && origin.Scheme != "https") || origin.User != nil || origin.RawQuery != "" || origin.Fragment != "" || origin.Path != "" {
		return errors.New("public_origin must be a complete HTTP(S) origin without path")
	}
	if cfg.SessionTTL <= 0 || cfg.ManagementTTL <= 0 || cfg.ManagementTTL > cfg.SessionTTL || cfg.UploadTimeout <= 0 || cfg.MediaCleanupInterval <= 0 || cfg.MediaOrphanTTL <= cfg.UploadTimeout+cfg.MediaProbeTimeout {
		return errors.New("invalid session or media lifetime")
	}
	l := cfg.Limits
	if l.PasswordMin < 1 || l.PasswordMax < l.PasswordMin || l.NameMax < 1 || l.TextMax < 1 || l.MessageMax < 1 || l.RewardMax < 0 || l.RewardMax > 9007199254740991 || l.PriceMax < 0 || l.PriceMax > 9007199254740991 || l.StockMax < 0 || l.StockMax > 9007199254740991 || l.DailyLimitMax < 1 || l.DailyLimitMax > 9007199254740991 || l.ListDaysMax < 1 || l.StatsDaysMax < 1 || l.PhotoBytesMax < 1 || l.PhotoPixelsMax < 1 || l.PhotoEdgeMax < 1 || l.AudioBytesMax < 1 || l.AudioSecondsMax != 60 {
		return errors.New("invalid business limits")
	}
	for name, value := range map[string]string{
		"listen_address": cfg.ListenAddress, "database_path": cfg.DatabasePath,
		"media_directory": cfg.MediaDirectory, "temp_directory": cfg.TempDirectory, "ffprobe_path": cfg.FFprobePath,
		"static_directory": cfg.StaticDirectory, "assets_directory": cfg.AssetsDirectory,
	} {
		if strings.TrimSpace(value) == "" {
			return fmt.Errorf("%s is required", name)
		}
	}
	if err := cfg.validateStoragePaths(); err != nil {
		return err
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
