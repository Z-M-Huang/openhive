package domain

import (
	"errors"
	"testing"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestValidateAID(t *testing.T) {
	tests := []struct {
		name    string
		aid     string
		wantErr bool
	}{
		{"valid", "aid-abc-123", false},
		{"valid multi segment", "aid-abc123-def456", false},
		{"empty", "", true},
		{"missing prefix", "abc-123-456", true},
		{"uppercase", "aid-ABC-123", true},
		{"no segments after prefix", "aid-", true},
		{"single segment", "aid-abc", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateAID(tt.aid)
			if tt.wantErr {
				assert.Error(t, err)
				var ve *ValidationError
				assert.True(t, errors.As(err, &ve))
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateTID(t *testing.T) {
	tests := []struct {
		name    string
		tid     string
		wantErr bool
	}{
		{"valid", "tid-abc-123", false},
		{"empty", "", true},
		{"wrong prefix", "aid-abc-123", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateTID(tt.tid)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateSlug(t *testing.T) {
	tests := []struct {
		name    string
		slug    string
		wantErr bool
	}{
		{"valid", "my-team", false},
		{"valid single word", "team", false},
		{"valid with numbers", "team-123", false},
		{"empty", "", true},
		{"uppercase", "My-Team", true},
		{"special chars", "my_team", true},
		{"spaces", "my team", true},
		{"leading hyphen", "-team", true},
		{"trailing hyphen", "team-", true},
	}
	for _, tt := range tests {
		t.Run(tt.name, func(t *testing.T) {
			err := ValidateSlug(tt.slug)
			if tt.wantErr {
				assert.Error(t, err)
			} else {
				assert.NoError(t, err)
			}
		})
	}
}

func TestValidateTeam(t *testing.T) {
	t.Run("valid team", func(t *testing.T) {
		team := &Team{Slug: "my-team", LeaderAID: "aid-lead-001"}
		assert.NoError(t, ValidateTeam(team))
	})

	t.Run("empty slug", func(t *testing.T) {
		team := &Team{LeaderAID: "aid-lead-001"}
		assert.Error(t, ValidateTeam(team))
	})

	t.Run("invalid slug", func(t *testing.T) {
		team := &Team{Slug: "My-Team", LeaderAID: "aid-lead-001"}
		assert.Error(t, ValidateTeam(team))
	})

	t.Run("empty leader_aid", func(t *testing.T) {
		team := &Team{Slug: "my-team"}
		assert.Error(t, ValidateTeam(team))
	})

	t.Run("invalid leader_aid", func(t *testing.T) {
		team := &Team{Slug: "my-team", LeaderAID: "bad-aid"}
		assert.Error(t, ValidateTeam(team))
	})

	t.Run("valid with TID", func(t *testing.T) {
		team := &Team{Slug: "my-team", LeaderAID: "aid-lead-001", TID: "tid-abc-123"}
		assert.NoError(t, ValidateTeam(team))
	})

	t.Run("invalid TID", func(t *testing.T) {
		team := &Team{Slug: "my-team", LeaderAID: "aid-lead-001", TID: "bad-tid"}
		assert.Error(t, ValidateTeam(team))
	})
}

func TestValidateAgent(t *testing.T) {
	t.Run("valid", func(t *testing.T) {
		agent := &Agent{AID: "aid-agent-001", Name: "test-agent"}
		assert.NoError(t, ValidateAgent(agent))
	})

	t.Run("empty AID", func(t *testing.T) {
		agent := &Agent{Name: "test-agent"}
		err := ValidateAgent(agent)
		require.Error(t, err)
		var ve *ValidationError
		assert.True(t, errors.As(err, &ve))
	})

	t.Run("invalid AID", func(t *testing.T) {
		agent := &Agent{AID: "bad", Name: "test-agent"}
		assert.Error(t, ValidateAgent(agent))
	})

	t.Run("empty name", func(t *testing.T) {
		agent := &Agent{AID: "aid-agent-001"}
		assert.Error(t, ValidateAgent(agent))
	})
}

func TestValidateProvider(t *testing.T) {
	t.Run("valid oauth", func(t *testing.T) {
		p := &Provider{Name: "default", Type: "oauth", OAuthToken: "test-oauth-token"}
		assert.NoError(t, ValidateProvider(p))
	})

	t.Run("valid direct with api_key", func(t *testing.T) {
		p := &Provider{Name: "direct", Type: "anthropic_direct", APIKey: "sk-123"}
		assert.NoError(t, ValidateProvider(p))
	})

	t.Run("empty name", func(t *testing.T) {
		p := &Provider{Type: "oauth", OAuthToken: "some-token"}
		assert.Error(t, ValidateProvider(p))
	})

	t.Run("unknown type", func(t *testing.T) {
		p := &Provider{Name: "bad", Type: "openai"}
		err := ValidateProvider(p)
		require.Error(t, err)
		var ve *ValidationError
		assert.True(t, errors.As(err, &ve))
	})

	t.Run("oauth without oauth_token", func(t *testing.T) {
		p := &Provider{Name: "default", Type: "oauth"}
		assert.Error(t, ValidateProvider(p))
	})

	t.Run("direct without api_key", func(t *testing.T) {
		p := &Provider{Name: "direct", Type: "anthropic_direct"}
		assert.Error(t, ValidateProvider(p))
	})
}

func TestSlugToDisplayName(t *testing.T) {
	tests := []struct {
		slug     string
		expected string
	}{
		{"my-dev-team", "My Dev Team"},
		{"team", "Team"},
		{"a-b-c", "A B C"},
		{"hello-world-123", "Hello World 123"},
	}
	for _, tt := range tests {
		assert.Equal(t, tt.expected, SlugToDisplayName(tt.slug))
	}
}
