package orchestrator

import (
	"os"
	"path/filepath"
	"testing"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

// createSkillTestDir creates a temporary data dir with a team skills directory.
func createSkillTestDir(t *testing.T, teamSlug string) string {
	t.Helper()
	dataDir := t.TempDir()
	skillsDir := filepath.Join(dataDir, "teams", teamSlug, "skills")
	require.NoError(t, os.MkdirAll(skillsDir, 0755))
	return dataDir
}

func writeSkillFile(t *testing.T, dataDir, teamSlug, filename, content string) {
	t.Helper()
	path := filepath.Join(dataDir, "teams", teamSlug, "skills", filename)
	require.NoError(t, os.WriteFile(path, []byte(content), 0600))
}

func TestLoadSkill_FromYAMLFile(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "coding.yaml", `
name: coding
description: Write production-quality Go code
model_tier: sonnet
tools:
  - write_file
  - read_file
`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skill, err := loader.LoadSkill("myteam", "coding")
	require.NoError(t, err)
	assert.Equal(t, "coding", skill.Name)
	assert.Equal(t, "sonnet", skill.ModelTier)
	assert.Contains(t, skill.Tools, "write_file")
}

func TestLoadSkill_FromJSONFile(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "analysis.json", `{
  "name": "analysis",
  "description": "Data analysis skill",
  "model_tier": "opus",
  "tools": ["read_file"]
}`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skill, err := loader.LoadSkill("myteam", "analysis")
	require.NoError(t, err)
	assert.Equal(t, "analysis", skill.Name)
	assert.Equal(t, "opus", skill.ModelTier)
}

func TestLoadSkill_ValidatesRequiredFields(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	// Skill with no name in file (name will be set from filename, so must have valid content)
	writeSkillFile(t, dataDir, "myteam", "empty-skill.yaml", `
model_tier: haiku
`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	// Name will be filled from filename "empty-skill" — this should pass validation
	skill, err := loader.LoadSkill("myteam", "empty-skill")
	require.NoError(t, err)
	assert.Equal(t, "empty-skill", skill.Name)
}

func TestLoadSkill_ValidatesModelTier(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "bad-tier.yaml", `
name: bad-tier
model_tier: ultra
`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	_, err := loader.LoadSkill("myteam", "bad-tier")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "model_tier")
}

func TestLoadSkill_RejectsPathTraversalInSkillName(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	loader := NewSkillLoader(dataDir, newTestLogger(t))

	_, err := loader.LoadSkill("myteam", "../../../etc/passwd")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "traversal")

	_, err = loader.LoadSkill("myteam", "some/nested/skill")
	require.Error(t, err)
}

func TestLoadSkill_RejectsPathTraversalInTeamSlug(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	loader := NewSkillLoader(dataDir, newTestLogger(t))

	_, err := loader.LoadSkill("../../etc", "skill")
	require.Error(t, err)
	assert.Contains(t, err.Error(), "slug")
}

func TestLoadSkill_ReturnsNotFoundErrorForMissingFile(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	loader := NewSkillLoader(dataDir, newTestLogger(t))

	_, err := loader.LoadSkill("myteam", "nonexistent")
	require.Error(t, err)
	var nfe *domain.NotFoundError
	assert.ErrorAs(t, err, &nfe)
}

func TestLoadAllSkills_LoadsAllSkillsFromDirectory(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "coding.yaml", `name: coding
model_tier: sonnet`)
	writeSkillFile(t, dataDir, "myteam", "research.yaml", `name: research
model_tier: haiku`)
	writeSkillFile(t, dataDir, "myteam", "analysis.json", `{"name":"analysis","model_tier":"opus"}`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skills, err := loader.LoadAllSkills("myteam")
	require.NoError(t, err)
	assert.Len(t, skills, 3)

	names := make(map[string]bool)
	for _, s := range skills {
		names[s.Name] = true
	}
	assert.True(t, names["coding"])
	assert.True(t, names["research"])
	assert.True(t, names["analysis"])
}

func TestLoadAllSkills_SkipsCompoundExtensionFiles(t *testing.T) {
	// A file named 'skill.yaml.json' has ext='.json' but its base name 'skill.yaml'
	// contains a dot which is not a valid skill identifier character.
	// LoadAllSkills must skip it rather than attempting to load it.
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "coding.yaml", `name: coding
model_tier: sonnet`)
	// Compound-extension file — should be silently skipped
	writeSkillFile(t, dataDir, "myteam", "skill.yaml.json", `{"name":"skill.yaml","model_tier":"haiku"}`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skills, err := loader.LoadAllSkills("myteam")
	require.NoError(t, err)
	// Only coding.yaml should be loaded; skill.yaml.json must be ignored
	assert.Len(t, skills, 1)
	assert.Equal(t, "coding", skills[0].Name)
}

func TestLoadAllSkills_EmptyDirectoryReturnsEmptySlice(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	loader := NewSkillLoader(dataDir, newTestLogger(t))

	skills, err := loader.LoadAllSkills("myteam")
	require.NoError(t, err)
	assert.Empty(t, skills)
}

func TestValidateSkill_ChecksToolNames(t *testing.T) {
	skill := &domain.Skill{
		Name:      "coding",
		ModelTier: "sonnet",
		Tools:     []string{"valid_tool", "write_file"},
	}
	assert.NoError(t, ValidateSkill(skill))

	// Invalid tool name with spaces
	skillBad := &domain.Skill{
		Name:      "coding",
		ModelTier: "sonnet",
		Tools:     []string{"tool with space"},
	}
	err := ValidateSkill(skillBad)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "tool")
}

func TestValidateSkill_RequiresName(t *testing.T) {
	skill := &domain.Skill{
		ModelTier: "sonnet",
	}
	err := ValidateSkill(skill)
	require.Error(t, err)
	assert.Contains(t, err.Error(), "name")
}

func TestLoadSkill_FromSkillMdWithFrontmatter(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "coding.skill.md", `---
name: coding
description: Write production-quality code
model_tier: sonnet
tools:
  - write_file
  - read_file
---
You are a coding expert. Follow best practices.`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skill, err := loader.LoadSkill("myteam", "coding")
	require.NoError(t, err)
	assert.Equal(t, "coding", skill.Name)
	assert.Equal(t, "sonnet", skill.ModelTier)
	assert.Contains(t, skill.Tools, "write_file")
	assert.Equal(t, "You are a coding expert. Follow best practices.", skill.SystemPromptAddition)
}

func TestLoadSkill_FromSkillMdWithoutFrontmatter(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "plain.skill.md", `You are a helpful assistant.
Always be concise.`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skill, err := loader.LoadSkill("myteam", "plain")
	require.NoError(t, err)
	assert.Equal(t, "plain", skill.Name) // name from filename
	assert.Equal(t, "You are a helpful assistant.\nAlways be concise.", skill.SystemPromptAddition)
}

func TestLoadSkill_FromSkillMdMalformedFrontmatter(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	// Opening --- but no closing --- : entire content becomes system prompt
	writeSkillFile(t, dataDir, "myteam", "broken.skill.md", `---
name: broken
this is not closed properly`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skill, err := loader.LoadSkill("myteam", "broken")
	require.NoError(t, err)
	// No closing delimiter: entire content (including ---) is treated as system prompt
	assert.Contains(t, skill.SystemPromptAddition, "---")
	assert.Contains(t, skill.SystemPromptAddition, "name: broken")
}

func TestLoadAllSkills_IncludesSkillMdFiles(t *testing.T) {
	dataDir := createSkillTestDir(t, "myteam")
	writeSkillFile(t, dataDir, "myteam", "coding.yaml", `name: coding
model_tier: sonnet`)
	writeSkillFile(t, dataDir, "myteam", "research.skill.md", `---
name: research
model_tier: haiku
---
Research instructions here.`)

	loader := NewSkillLoader(dataDir, newTestLogger(t))
	skills, err := loader.LoadAllSkills("myteam")
	require.NoError(t, err)
	assert.Len(t, skills, 2)

	names := make(map[string]bool)
	for _, s := range skills {
		names[s.Name] = true
	}
	assert.True(t, names["coding"])
	assert.True(t, names["research"])
}
