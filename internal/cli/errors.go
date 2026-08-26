package cli

import (
	"fmt"
	"os"

	"github.com/spf13/cobra"
)

// ReportError prints a failure the way the resolved output mode requires.
//
// It is called from main rather than inside a command so that a failure during
// flag parsing — before any output.Writer exists — is still reported.
func ReportError(root *cobra.Command, err error) {
	if err == nil {
		return
	}
	fmt.Fprintf(os.Stderr, "Error: %v\n", err)
}
