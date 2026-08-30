package cli

import (
	"context"
	"os"
	"time"

	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/TakashiAihara/kaneo-cli/internal/output"
	"github.com/spf13/cobra"
)

type globalFlags struct {
	apiURL    string
	apiKey    string
	workspace string
	project   string
	json      bool
	human     bool
	timeout   time.Duration
}

// NewRootCommand builds the whole command tree. The App is returned so that
// main can report a failure through the same output mode the commands used.
func NewRootCommand(version string) (*cobra.Command, *App) {
	var flags globalFlags
	app := &App{}

	root := &cobra.Command{
		Use:           "kaneo",
		Short:         "Command-line client for Kaneo",
		Version:       version,
		SilenceUsage:  true,
		SilenceErrors: true,
		PersistentPreRunE: func(cmd *cobra.Command, args []string) error {
			mode := output.ResolveMode(
				flags.json,
				flags.human,
				output.IsTTY(os.Stdout),
				os.Getenv("NO_COLOR") != "",
			)
			app.Out = output.New(mode)
			app.Timeout = flags.timeout

			ctx, cancel := context.WithTimeout(cmd.Context(), 2*time.Second)
			defer cancel()

			resolved, global, err := config.ResolveFromEnvironment(ctx, config.Flags{
				APIURL:      flags.apiURL,
				APIKey:      flags.apiKey,
				WorkspaceID: flags.workspace,
				ProjectID:   flags.project,
			})
			if err != nil {
				return err
			}
			app.Cfg, app.Global = resolved, global
			return nil
		},
	}

	p := root.PersistentFlags()
	p.StringVar(&flags.apiURL, "api-url", "", "Kaneo base URL (env KANEO_API_URL)")
	p.StringVar(&flags.apiKey, "api-key", "", "API key; prefer KANEO_API_KEY, since a flag is visible in the process list")
	p.StringVarP(&flags.workspace, "workspace", "w", "", "workspace id (env KANEO_WORKSPACE)")
	p.StringVarP(&flags.project, "project", "p", "", "project id (env KANEO_PROJECT)")
	p.BoolVar(&flags.json, "json", false, "force JSON output")
	p.BoolVar(&flags.human, "human", false, "force human-readable output, even through a pipe")
	p.DurationVar(&flags.timeout, "timeout", 10*time.Second, "per-request timeout")

	root.AddCommand(
		newContextCommand(app),
		newWhoamiCommand(app),
		newWorkspaceCommand(app),
		newProjectCommand(app),
		newTaskCommand(app),
		newBoardCommand(app),
		newSessionCommand(app),
		newCommentCommand(app),
		newAPICheckCommand(app),
	)
	return root, app
}
