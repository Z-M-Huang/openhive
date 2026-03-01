package config

import (
	"fmt"
	"os"
	"path/filepath"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gopkg.in/yaml.v3"
)

// LoadTeamFromFile reads and parses a team.yaml file.
func LoadTeamFromFile(path string, slug string) (*domain.Team, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("failed to read team config %s: %w", path, err)
	}

	var team domain.Team
	if err := yaml.Unmarshal(data, &team); err != nil {
		return nil, fmt.Errorf("failed to parse team config %s: %w", path, err)
	}

	team.Slug = slug
	return &team, nil
}

// SaveTeamToFile writes a team config atomically.
func SaveTeamToFile(path string, team *domain.Team) error {
	data, err := yaml.Marshal(team)
	if err != nil {
		return fmt.Errorf("failed to marshal team config: %w", err)
	}

	dir := filepath.Dir(path)
	if err := os.MkdirAll(dir, 0755); err != nil {
		return fmt.Errorf("failed to create team directory: %w", err)
	}

	tmpPath := path + ".tmp"
	if err := os.WriteFile(tmpPath, data, 0644); err != nil {
		return fmt.Errorf("failed to write temp team config: %w", err)
	}

	if err := os.Rename(tmpPath, path); err != nil {
		_ = os.Remove(tmpPath)
		return fmt.Errorf("failed to rename temp team config: %w", err)
	}

	return nil
}

// CreateTeamDirectory creates the directory structure for a new team.
func CreateTeamDirectory(dataDir string, slug string) error {
	if err := domain.ValidateSlug(slug); err != nil {
		return err
	}

	teamDir := filepath.Join(dataDir, "teams", slug)
	dirs := []string{
		teamDir,
		filepath.Join(teamDir, "agents"),
		filepath.Join(teamDir, "skills"),
	}

	for _, dir := range dirs {
		if err := os.MkdirAll(dir, 0755); err != nil {
			return fmt.Errorf("failed to create directory %s: %w", dir, err)
		}
	}

	// Create minimal team.yaml
	teamFile := filepath.Join(teamDir, "team.yaml")
	if _, err := os.Stat(teamFile); os.IsNotExist(err) {
		minimalTeam := &domain.Team{Slug: slug}
		data, err := yaml.Marshal(minimalTeam)
		if err != nil {
			return fmt.Errorf("failed to marshal minimal team config: %w", err)
		}
		if err := os.WriteFile(teamFile, data, 0644); err != nil {
			return fmt.Errorf("failed to write team.yaml: %w", err)
		}
	}

	// Create CLAUDE.md
	claudeFile := filepath.Join(teamDir, "CLAUDE.md")
	if _, err := os.Stat(claudeFile); os.IsNotExist(err) {
		content := fmt.Sprintf("# %s\n\nTeam-specific instructions.\n", domain.SlugToDisplayName(slug))
		if err := os.WriteFile(claudeFile, []byte(content), 0644); err != nil {
			return fmt.Errorf("failed to write CLAUDE.md: %w", err)
		}
	}

	return nil
}
