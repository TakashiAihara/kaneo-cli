package main

import (
	"context"
	"os"

	"github.com/TakashiAihara/kaneo-cli/internal/cli"
)

// version is overwritten at build time with the release tag.
var version = "dev"

func main() {
	root, app := cli.NewRootCommand(version)
	if err := root.ExecuteContext(context.Background()); err != nil {
		cli.ReportError(app, os.Args[1:], err)
		os.Exit(1)
	}
}
