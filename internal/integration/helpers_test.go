package integration

import (
	"github.com/Z-M-Huang/openhive/internal/config"
	"github.com/Z-M-Huang/openhive/internal/domain"
)

func newConfigLoader(dataDir string) (domain.ConfigLoader, error) {
	return config.NewLoader(dataDir, dataDir)
}
