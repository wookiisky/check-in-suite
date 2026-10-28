// Command island runs the local server or explicitly migrates its database.
package main

import (
	"context"
	"errors"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"syscall"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/assets"
	"github.com/wookiisky/check-in-suite/internal/checkin"
	"github.com/wookiisky/check-in-suite/internal/config"
	"github.com/wookiisky/check-in-suite/internal/content"
	"github.com/wookiisky/check-in-suite/internal/httpapi"
	"github.com/wookiisky/check-in-suite/internal/media"
	"github.com/wookiisky/check-in-suite/internal/message"
	"github.com/wookiisky/check-in-suite/internal/shop"
	"github.com/wookiisky/check-in-suite/internal/storage"
	"github.com/wookiisky/check-in-suite/migrations"
)

// main installs structured logging and reports terminal startup failures.
func main() {
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stderr, nil)))
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	if err := run(ctx, os.Args[1:]); err != nil {
		slog.Error("应用运行失败", "error", err)
		os.Exit(1)
	}
}

// run prepares explicit configuration and dispatches only implemented subcommands.
func run(ctx context.Context, args []string) error {
	return runWithIO(ctx, args, os.Stdin, os.Stdout)
}

// runWithIO separates interactive input from command dispatch for real database tests.
func runWithIO(ctx context.Context, args []string, input io.Reader, output io.Writer) error {
	if len(args) > 0 && args[0] == "version" {
		if len(args) != 1 {
			return errors.New(content.Text("unexpected_arguments"))
		}
		return printVersion(output)
	}
	if len(args) == 0 || (args[0] != "serve" && args[0] != "migrate" && args[0] != "init" && args[0] != "reset-password") {
		return errors.New(content.Text("usage"))
	}
	flags := flag.NewFlagSet(args[0], flag.ContinueOnError)
	flags.SetOutput(io.Discard)
	configuration := flags.String("config", "config/app.example.yaml", "configuration file")
	kind := ""
	if args[0] == "reset-password" {
		flags.StringVar(&kind, "kind", "", "credential type")
	}
	if err := flags.Parse(args[1:]); err != nil {
		return errors.New(content.Text("usage"))
	}
	if flags.NArg() != 0 {
		return errors.New(content.Text("unexpected_arguments"))
	}
	cfg, err := config.Load(*configuration)
	if err != nil {
		return err
	}
	if err := os.MkdirAll(filepath.Dir(cfg.DatabasePath), 0700); err != nil {
		return fmt.Errorf("create database directory: %w", err)
	}
	startupContext, cancel := context.WithTimeout(ctx, cfg.HTTPTimeout)
	defer cancel()
	db, err := storage.Open(startupContext, cfg.DatabasePath, cfg.SQLiteBusyTimeout)
	if err != nil {
		return err
	}
	defer db.Close()
	if args[0] == "migrate" {
		if err := storage.Migrate(startupContext, db, migrations.Files); err != nil {
			return err
		}
		slog.Info("数据库迁移完成")
		return nil
	}
	if err := storage.CheckSchema(startupContext, db, migrations.Files); err != nil {
		return err
	}
	accounts := account.New(db, cfg)
	if args[0] == "init" || args[0] == "reset-password" {
		return maintain(ctx, args[0], kind, accounts, input, output)
	}
	for _, directory := range []string{cfg.MediaDirectory, cfg.TempDirectory} {
		if err := os.MkdirAll(directory, 0700); err != nil {
			return fmt.Errorf("create private directory: %w", err)
		}
	}
	ready := &httpapi.Readiness{DB: db, FFprobePath: cfg.FFprobePath, ProbeTimeout: cfg.MediaProbeTimeout}
	if err := ready.Check(startupContext); err != nil {
		return err
	}
	application := httpapi.NewApplication(ready, cfg, accounts)
	artwork := assets.New(cfg.AssetsDirectory)
	if err := artwork.Install(); err != nil {
		return err
	}
	application.RegisterAssets(artwork)
	checkins := checkin.New(db, accounts, cfg)
	application.RegisterCheckins(checkins)
	application.RegisterShop(shop.New(db, cfg, accounts))
	application.RegisterQueries(checkins)
	application.RegisterMessages(message.New(db, cfg))
	attachments := media.New(db, accounts, cfg)
	application.RegisterMedia(attachments)
	cleanupContext, stopCleanup := context.WithCancel(ctx)
	cleanupDone := make(chan struct{})
	go func() {
		defer close(cleanupDone)
		attachments.RunCleanup(cleanupContext)
	}()
	defer func() { stopCleanup(); <-cleanupDone }()
	return serve(ctx, cfg, application)
}

// serve binds before reporting readiness and drains requests before closing the database.
func serve(ctx context.Context, cfg config.Config, handler http.Handler) error {
	listener, err := net.Listen("tcp", cfg.ListenAddress)
	if err != nil {
		return err
	}
	server := &http.Server{
		Addr:              cfg.ListenAddress,
		Handler:           handler,
		ReadHeaderTimeout: cfg.HTTPTimeout,
		ReadTimeout:       max(cfg.HTTPTimeout, cfg.UploadTimeout),
		WriteTimeout:      max(cfg.HTTPTimeout, cfg.UploadTimeout),
		IdleTimeout:       cfg.HTTPTimeout,
	}
	finished := make(chan error, 1)
	go func() { finished <- server.Serve(listener) }()
	slog.Info("服务启动成功", "address", listener.Addr().String(), "timezone", cfg.Location.String())
	select {
	case err := <-finished:
		if errors.Is(err, http.ErrServerClosed) {
			return nil
		}
		return err
	case <-ctx.Done():
		shutdownContext, cancel := context.WithTimeout(context.Background(), max(cfg.HTTPTimeout, cfg.UploadTimeout))
		defer cancel()
		if err := server.Shutdown(shutdownContext); err != nil {
			server.Close()
			return fmt.Errorf("shutdown server: %w", err)
		}
		if err := <-finished; err != nil && !errors.Is(err, http.ErrServerClosed) {
			return err
		}
		slog.Info("服务停止完成")
		return nil
	}
}
