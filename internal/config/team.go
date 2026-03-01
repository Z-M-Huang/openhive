package config

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gopkg.in/yaml.v3"
)

// ValidateTeamPath validates a team slug and returns a safe absolute path within
// the expected data directory. It enforces NFR13:
//  1. Validates slug format via domain.ValidateSlug
//  2. Resolves the constructed path to absolute
//  3. Verifies the resolved path starts with the expected teams directory prefix
//  4. Uses os.Lstat to detect symlinks (does not follow them)
//
// Returns the validated absolute team directory path or an error.
func ValidateTeamPath(dataDir string, slug string) (string, error) {
	if err := domain.ValidateSlug(slug); err != nil {
		return "", err
	}

	absDataDir, err := filepath.Abs(dataDir)
	if err != nil {
		return "", fmt.Errorf("failed to resolve data directory: %w", err)
	}

	teamsPrefix := filepath.Join(absDataDir, "teams") + string(filepath.Separator)
	teamDir := filepath.Join(absDataDir, "teams", slug)

	absTeamDir, err := filepath.Abs(teamDir)
	if err != nil {
		return "", fmt.Errorf("failed to resolve team path: %w", err)
	}

	// Verify the resolved path is strictly within the teams directory.
	// The path must start with the teams prefix (teamsDir + separator).
	if !strings.HasPrefix(absTeamDir+string(filepath.Separator), teamsPrefix) || absTeamDir == filepath.Join(absDataDir, "teams") {
		return "", &domain.ValidationError{
			Field:   "slug",
			Message: "resolved path escapes teams directory",
		}
	}

	// Check for symlinks at the team directory level to prevent symlink attacks.
	// Only check if the path already exists.
	info, err := os.Lstat(absTeamDir)
	if err == nil {
		// Path exists - verify it is not a symlink
		if info.Mode()&os.ModeSymlink != 0 {
			return "", &domain.ValidationError{
				Field:   "slug",
				Message: "team directory is a symlink",
			}
		}
	}
	// If Lstat returns an error (e.g., path doesn't exist), that's fine for
	// creation operations.

	return absTeamDir, nil
}

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
	teamDir, err := ValidateTeamPath(dataDir, slug)
	if err != nil {
		return err
	}

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
	if _, err := os.Lstat(teamFile); os.IsNotExist(err) {
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
	if _, err := os.Lstat(claudeFile); os.IsNotExist(err) {
		content := fmt.Sprintf("# %s\n\nTeam-specific instructions.\n", domain.SlugToDisplayName(slug))
		if err := os.WriteFile(claudeFile, []byte(content), 0644); err != nil {
			return fmt.Errorf("failed to write CLAUDE.md: %w", err)
		}
	}

	return nil
}
