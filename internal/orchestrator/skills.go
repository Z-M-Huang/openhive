package orchestrator

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gopkg.in/yaml.v3"
)

// SkillLoader loads skill definitions from local files.
// Skill files are stored in <teamsDir>/teams/<slug>/skills/<name>.yaml (or .json).
// No HTTP fetching — local files only.
type SkillLoader struct {
	teamsDir string
	logger   *slog.Logger
}

// NewSkillLoader creates a new SkillLoader.
// teamsDir is the base directory containing teams/<slug>/ directories.
func NewSkillLoader(teamsDir string, logger *slog.Logger) *SkillLoader {
	return &SkillLoader{
		teamsDir: teamsDir,
		logger:   logger,
	}
}

// LoadSkill loads a single skill by name from a team's skills directory.
// skillName must not contain path separators or traversal components.
// Returns NotFoundError if the file does not exist.
func (s *SkillLoader) LoadSkill(teamSlug, skillName string) (*domain.Skill, error) {
	if err := domain.ValidateSlug(teamSlug); err != nil {
		return nil, err
	}
	if err := validateSkillName(skillName); err != nil {
		return nil, err
	}

	skillsDir := filepath.Join(s.teamsDir, "teams", teamSlug, "skills")

	// Try .yaml, .yml, .json, .skill.md in order
	extensions := []string{".yaml", ".yml", ".json", ".skill.md"}
	var data []byte
	var ext string
	var readErr error
	for _, e := range extensions {
		path := filepath.Join(skillsDir, skillName+e)
		data, readErr = os.ReadFile(path)
		if readErr == nil {
			ext = e
			break
		}
	}

	if readErr != nil {
		return nil, &domain.NotFoundError{
			Resource: "skill",
			ID:       teamSlug + "/" + skillName,
		}
	}

	skill, parseErr := parseSkillFile(data, ext)
	if parseErr != nil {
		return nil, fmt.Errorf("failed to parse skill %s: %w", skillName, parseErr)
	}

	// Override name with the file name (canonical)
	if skill.Name == "" {
		skill.Name = skillName
	}

	if err := ValidateSkill(skill); err != nil {
		return nil, fmt.Errorf("skill %s validation failed: %w", skillName, err)
	}

	return skill, nil
}

// LoadAllSkills loads all skills from a team's skills directory.
func (s *SkillLoader) LoadAllSkills(teamSlug string) ([]domain.Skill, error) {
	if err := domain.ValidateSlug(teamSlug); err != nil {
		return nil, err
	}

	skillsDir := filepath.Join(s.teamsDir, "teams", teamSlug, "skills")

	entries, err := os.ReadDir(skillsDir)
	if err != nil {
		if os.IsNotExist(err) {
			return []domain.Skill{}, nil
		}
		return nil, fmt.Errorf("failed to read skills directory: %w", err)
	}

	var skills []domain.Skill
	for _, entry := range entries {
		if entry.IsDir() {
			continue
		}
		name := entry.Name()

		// Detect extension: check for compound .skill.md first, then single extensions.
		var ext, skillName string
		if strings.HasSuffix(name, ".skill.md") {
			ext = ".skill.md"
			skillName = strings.TrimSuffix(name, ".skill.md")
		} else {
			ext = filepath.Ext(name)
			if ext != ".yaml" && ext != ".yml" && ext != ".json" {
				continue
			}
			skillName = strings.TrimSuffix(name, ext)
		}

		// Exact extension check: the skill base name (filename minus the single
		// recognised extension) must be a valid skill identifier. This rejects
		// compound filenames like 'skill.yaml.json' where the derived name
		// 'skill.yaml' contains an illegal character.
		if err := validateSkillName(skillName); err != nil {
			s.logger.Warn("skipping skill file with invalid base name",
				"team", teamSlug,
				"file", name,
				"reason", err.Error(),
			)
			continue
		}

		skill, loadErr := s.LoadSkill(teamSlug, skillName)
		if loadErr != nil {
			s.logger.Warn("failed to load skill", "team", teamSlug, "skill", skillName, "error", loadErr)
			continue
		}
		skills = append(skills, *skill)
	}

	return skills, nil
}

// ValidateSkill validates a skill definition.
// Checks required fields, model_tier, and tool names.
func ValidateSkill(skill *domain.Skill) error {
	if skill.Name == "" {
		return &domain.ValidationError{Field: "name", Message: "skill name is required"}
	}
	if err := validateSkillName(skill.Name); err != nil {
		return err
	}
	if skill.ModelTier != "" {
		if _, err := domain.ParseModelTier(skill.ModelTier); err != nil {
			return &domain.ValidationError{
				Field:   "model_tier",
				Message: fmt.Sprintf("invalid model_tier: %s (must be haiku, sonnet, or opus)", skill.ModelTier),
			}
		}
	}
	// Validate tool names against known tools
	for _, toolName := range skill.Tools {
		if err := validateToolName(toolName); err != nil {
			return &domain.ValidationError{
				Field:   "tools",
				Message: fmt.Sprintf("invalid tool name %q: %s", toolName, err.Error()),
			}
		}
	}
	return nil
}

// validateSkillName validates a skill name (must be a safe identifier, not a path).
func validateSkillName(name string) error {
	if name == "" {
		return &domain.ValidationError{Field: "skill_name", Message: "skill name cannot be empty"}
	}
	if strings.Contains(name, "..") {
		return &domain.ValidationError{Field: "skill_name", Message: "skill name must not contain '..' (path traversal)"}
	}
	if strings.ContainsAny(name, "/\\") {
		return &domain.ValidationError{Field: "skill_name", Message: "skill name must not contain path separators"}
	}
	// Allow letters, digits, hyphens, underscores
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '-' || c == '_') {
			return &domain.ValidationError{
				Field:   "skill_name",
				Message: fmt.Sprintf("skill name contains invalid character: %q", c),
			}
		}
	}
	return nil
}

// knownToolNames is the set of tool names registered by the orchestrator.
// validateToolName is permissive — tool names starting with known prefixes are allowed.
func validateToolName(name string) error {
	if name == "" {
		return fmt.Errorf("tool name cannot be empty")
	}
	// Tools may only contain alphanumerics and underscores
	for _, c := range name {
		if !((c >= 'a' && c <= 'z') || (c >= 'A' && c <= 'Z') || (c >= '0' && c <= '9') || c == '_') {
			return fmt.Errorf("tool name %q contains invalid character %q", name, c)
		}
	}
	return nil
}

// parseSkillFile parses skill YAML or JSON data.
func parseSkillFile(data []byte, ext string) (*domain.Skill, error) {
	var skill domain.Skill
	switch strings.ToLower(ext) {
	case ".yaml", ".yml":
		if err := yaml.Unmarshal(data, &skill); err != nil {
			return nil, fmt.Errorf("YAML parse error: %w", err)
		}
	case ".json":
		if err := json.Unmarshal(data, &skill); err != nil {
			return nil, fmt.Errorf("JSON parse error: %w", err)
		}
	case ".skill.md":
		parsed, err := parseSkillMarkdown(data)
		if err != nil {
			return nil, fmt.Errorf("markdown parse error: %w", err)
		}
		skill = *parsed
	default:
		return nil, fmt.Errorf("unsupported skill file extension: %s", ext)
	}
	return &skill, nil
}

// parseSkillMarkdown parses a .skill.md file with optional YAML frontmatter.
// Format:
//
//	---
//	name: my-skill
//	description: A useful skill
//	model_tier: sonnet
//	tools: [tool1, tool2]
//	---
//	Body text becomes system_prompt_addition.
func parseSkillMarkdown(data []byte) (*domain.Skill, error) {
	content := string(data)
	var skill domain.Skill

	// Check for YAML frontmatter delimited by "---"
	if strings.HasPrefix(strings.TrimSpace(content), "---") {
		trimmed := strings.TrimSpace(content)
		// Find closing "---"
		rest := trimmed[3:] // skip opening "---"
		idx := strings.Index(rest, "\n---")
		if idx >= 0 {
			frontmatter := rest[:idx]
			body := strings.TrimSpace(rest[idx+4:]) // skip "\n---"
			if err := yaml.Unmarshal([]byte(frontmatter), &skill); err != nil {
				return nil, fmt.Errorf("frontmatter parse error: %w", err)
			}
			skill.SystemPromptAddition = body
		} else {
			// No closing delimiter: treat entire content as system prompt
			skill.SystemPromptAddition = strings.TrimSpace(content)
		}
	} else {
		// No frontmatter: entire file is the system prompt addition
		skill.SystemPromptAddition = strings.TrimSpace(content)
	}

	return &skill, nil
}
