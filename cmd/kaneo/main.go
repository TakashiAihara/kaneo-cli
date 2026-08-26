package main

import (
	"context"
	"os"

	"github.com/TakashiAihara/kaneo-cli/internal/cli"
)

// version is overwritten at build time with the release tag.
var version = "dev"

func main() {
	root := cli.NewRootCommand(version)
	if err := root.ExecuteContext(context.Background()); err != nil {
		cli.ReportError(root, err)
		os.Exit(1)
	}
}
