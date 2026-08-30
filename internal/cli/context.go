package cli

import (
	"github.com/TakashiAihara/kaneo-cli/internal/config"
	"github.com/spf13/cobra"
)

type contextReport struct {
	APIURL     string                   `json:"api_url"`
	Workspace  string                   `json:"workspace"`
	Project    string                   `json:"project"`
	Repo       string                   `json:"repo,omitempty"`
	Profile    string                   `json:"profile,omitempty"`
	LocalFile  string                   `json:"local_file,omitempty"`
	ConfigFile string                   `json:"config_file,omitempty"`
	HasAPIKey  bool                     `json:"has_api_key"`
	Origin     map[string]config.Source `json:"origin"`
}

// newContextCommand shows what the resolution chain settled on and which layer
// supplied each value. It never prints the key itself.
func newContextCommand(app *App) *cobra.Command {
	return &cobra.Command{
		Use:   "context",
		Short: "Show the resolved settings and where each value came from",
		Args:  cobra.NoArgs,
		RunE: func(cmd *cobra.Command, args []string) error {
			r := contextReport{
				APIURL:    app.Cfg.APIURL,
				Workspace: app.Cfg.WorkspaceID,
				Project:   app.Cfg.ProjectID,
				Repo:      app.Cfg.Repo,
				Profile:   app.Cfg.ProfileName,
				LocalFile: app.Cfg.LocalPath,
				HasAPIKey: app.Cfg.APIKey != "",
				Origin:    app.Cfg.Origin,
			}
			if app.Global != nil {
				r.ConfigFile = app.Global.Path()
			}

			app.Out.Human("api url    %s  (%s)", or(r.APIURL, "-"), app.Cfg.Origin["api_url"])
			app.Out.Human("api key    %s  (%s)", presence(r.HasAPIKey), app.Cfg.Origin["api_key"])
			app.Out.Human("workspace  %s  (%s)", or(r.Workspace, "-"), app.Cfg.Origin["workspace"])
			app.Out.Human("project    %s  (%s)", or(r.Project, "-"), app.Cfg.Origin["project"])
			app.Out.Human("")
			app.Out.Human("repo       %s", or(r.Repo, "-"))
			app.Out.Human("profile    %s", or(r.Profile, "-"))
			app.Out.Human("local file %s", or(r.LocalFile, "-"))
			app.Out.Human("config     %s", or(r.ConfigFile, "-"))

			return app.Out.Data(r)
		},
	}
}

func or(s, fallback string) string {
	if s == "" {
		return fallback
	}
	return s
}

func presence(ok bool) string {
	if ok {
		return "set"
	}
	return "not set"
}
