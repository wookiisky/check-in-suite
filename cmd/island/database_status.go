package main

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net"
	"path/filepath"
	"strconv"
	"strings"
	"unicode"

	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/content"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// deploymentStatus adds resolved configuration paths to the observed database state.
type deploymentStatus struct {
	storage.DatabaseStatus        // Database facts from one read-only snapshot.
	HealthURL              string `json:"health_url"`       // Loopback endpoint corresponding to the configured listener.
	FFprobePath            string `json:"ffprobe_path"`     // Probe executable used by the service account.
	MediaDirectory         string `json:"media_directory"`  // Absolute private attachment path.
	TempDirectory          string `json:"temp_directory"`   // Absolute temporary upload path.
	AssetsDirectory        string `json:"assets_directory"` // Absolute persistent artwork path.
	PublicOrigin           string `json:"public_origin"`    // Browser origin retained during deployments.
}

// databaseStatus emits either JSON or a fixed TSV protocol without creating application directories.
func databaseStatus(ctx context.Context, cfg config.Config, output io.Writer, format string) error {
	if format != "json" && format != "tsv" {
		return errors.New(content.Text("invalid_status_format"))
	}
	ctx, cancel := context.WithTimeout(ctx, cfg.HTTPTimeout)
	defer cancel()
	observed, err := storage.Inspect(ctx, cfg.DatabasePath, migrations.Files)
	if err != nil {
		return err
	}
	host, port, err := net.SplitHostPort(cfg.ListenAddress)
	if err != nil {
		return err
	}
	if host == "" || host == "0.0.0.0" {
		host = "127.0.0.1"
	} else if host == "::" {
		host = "::1"
	}
	result := deploymentStatus{DatabaseStatus: observed, HealthURL: "http://" + net.JoinHostPort(host, port), FFprobePath: cfg.FFprobePath, PublicOrigin: cfg.PublicOrigin}
	for _, item := range []struct {
		source string
		target *string
	}{{cfg.MediaDirectory, &result.MediaDirectory}, {cfg.TempDirectory, &result.TempDirectory}, {cfg.AssetsDirectory, &result.AssetsDirectory}} {
		*item.target, err = filepath.Abs(item.source)
		if err != nil {
			return err
		}
	}
	if format == "json" {
		return json.NewEncoder(output).Encode(result)
	}
	fields := []string{result.State, result.DatabasePath, strconv.FormatBool(result.AccountExists), strconv.FormatBool(result.DemoComplete), result.HealthURL, result.FFprobePath, result.MediaDirectory, result.TempDirectory, result.AssetsDirectory, result.PublicOrigin}
	for _, field := range fields {
		if strings.ContainsFunc(field, unicode.IsControl) {
			return errors.New(content.Text("invalid_status_field"))
		}
	}
	_, err = fmt.Fprintln(output, strings.Join(fields, "\t"))
	return err
}
