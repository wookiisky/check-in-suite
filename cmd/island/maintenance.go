package main

import (
	"bufio"
	"context"
	"errors"
	"fmt"
	"io"
	"os"
	"strings"

	"github.com/wookiisky/check-in-suite/internal/account"
	"github.com/wookiisky/check-in-suite/internal/content"
	"github.com/wookiisky/check-in-suite/internal/core"
	"golang.org/x/term"
)

// terminalInput supports hidden terminal entry and non-echoing standard-input pipelines.
type terminalInput struct {
	Reader *bufio.Reader // Buffered input shared across all non-terminal prompts.
	Output io.Writer     // Destination for localized prompts, never passwords.
	File   *os.File      // Terminal input when available; nil for ordinary readers.
}

// read prints one prompt and accepts one complete line without exposing its value.
func (input *terminalInput) read(key string, secret bool) (string, error) {
	if _, err := fmt.Fprint(input.Output, content.Text(key)); err != nil {
		return "", err
	}
	if secret && input.File != nil && term.IsTerminal(int(input.File.Fd())) {
		value, err := term.ReadPassword(int(input.File.Fd()))
		fmt.Fprintln(input.Output)
		if err != nil {
			return "", errors.New(content.Text("input_failed"))
		}
		return string(value), nil
	}
	value, err := input.Reader.ReadString('\n')
	if err != nil && !(errors.Is(err, io.EOF) && len(value) > 0) {
		return "", errors.New(content.Text("input_failed"))
	}
	return strings.TrimSuffix(strings.TrimSuffix(value, "\n"), "\r"), nil
}

// password asks for independent confirmation before changing persistent credentials.
func (input *terminalInput) password(key string) (string, error) {
	password, err := input.read(key, true)
	if err != nil {
		return "", err
	}
	confirmation, err := input.read("confirm_password_prompt", true)
	if err != nil {
		return "", err
	}
	if password != confirmation {
		return "", errors.New(content.Text("password_mismatch"))
	}
	return password, nil
}

// maintain executes the authorized local account lifecycle without password arguments.
func maintain(ctx context.Context, command, kind string, service *account.Service, input io.Reader, output io.Writer) error {
	terminal := &terminalInput{Reader: bufio.NewReader(input), Output: output}
	terminal.File, _ = input.(*os.File)
	if command == "reset-password" {
		if kind != "login" && kind != "management" {
			return errors.New(content.Text("invalid_password_kind"))
		}
		password, err := terminal.password("new_password_prompt")
		if err != nil {
			return err
		}
		if err := service.ResetPassword(ctx, kind, password); err != nil {
			return maintenanceError(err)
		}
		_, err = fmt.Fprintln(output, content.Text("password_reset"))
		return err
	}
	username, err := terminal.read("username_prompt", false)
	if err != nil {
		return err
	}
	displayName, err := terminal.read("display_name_prompt", false)
	if err != nil {
		return err
	}
	loginPassword, err := terminal.password("login_password_prompt")
	if err != nil {
		return err
	}
	managementPassword, err := terminal.password("management_password_prompt")
	if err != nil {
		return err
	}
	if err := service.Initialize(ctx, username, displayName, loginPassword, managementPassword); err != nil {
		return maintenanceError(err)
	}
	_, err = fmt.Fprintln(output, content.Text("account_initialized"))
	return err
}

// maintenanceError maps expected input errors while preserving operational diagnostics.
func maintenanceError(err error) error {
	var domainError *core.Error
	if errors.As(err, &domainError) {
		return errors.New(content.Text(domainError.Code))
	}
	return err
}
