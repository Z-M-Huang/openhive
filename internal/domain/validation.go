package domain

import (
	"regexp"
	"strings"
)

var (
	aidPattern  = regexp.MustCompile(`^aid-[a-z0-9]+-[a-z0-9]+$`)
	tidPattern  = regexp.MustCompile(`^tid-[a-z0-9]+-[a-z0-9]+$`)
	slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
)

// ValidateAID checks that an agent ID matches the expected format (aid-xxx-xxx).
func ValidateAID(aid string) error {
	if aid == "" {
		return &ValidationError{Field: "aid", Message: "cannot be empty"}
	}
	if !aidPattern.MatchString(aid) {
		return &ValidationError{Field: "aid", Message: "must match format aid-xxx-xxx"}
	}
	return nil
}

// ValidateTID checks that a team ID matches the expected format (tid-xxx-xxx).
func ValidateTID(tid string) error {
	if tid == "" {
		return &ValidationError{Field: "tid", Message: "cannot be empty"}
	}
	if !tidPattern.MatchString(tid) {
		return &ValidationError{Field: "tid", Message: "must match format tid-xxx-xxx"}
	}
	return nil
}

// ValidateSlug checks that a slug is a valid lowercase kebab-case identifier.
func ValidateSlug(slug string) error {
	if slug == "" {
		return &ValidationError{Field: "slug", Message: "cannot be empty"}
	}
	if !slugPattern.MatchString(slug) {
		return &ValidationError{Field: "slug", Message: "must be lowercase letters, numbers, and hyphens only"}
	}
	return nil
}

// ValidateTeam validates a Team struct.
func ValidateTeam(t *Team) error {
	if err := ValidateSlug(t.Slug); err != nil {
		return err
	}
	if t.LeaderAID == "" {
		return &ValidationError{Field: "leader_aid", Message: "cannot be empty"}
	}
	if err := ValidateAID(t.LeaderAID); err != nil {
		return err
	}
	if t.TID != "" {
		if err := ValidateTID(t.TID); err != nil {
			return err
		}
	}
	return nil
}

// ValidateAgent validates an Agent struct.
func ValidateAgent(a *Agent) error {
	if a.AID == "" {
		return &ValidationError{Field: "aid", Message: "cannot be empty"}
	}
	if err := ValidateAID(a.AID); err != nil {
		return err
	}
	if a.Name == "" {
		return &ValidationError{Field: "name", Message: "cannot be empty"}
	}
	return nil
}

// ValidateProvider validates a Provider struct.
func ValidateProvider(p *Provider) error {
	if p.Name == "" {
		return &ValidationError{Field: "name", Message: "cannot be empty"}
	}
	pt, err := ParseProviderType(p.Type)
	if err != nil {
		return &ValidationError{Field: "type", Message: "unknown provider type: " + p.Type}
	}
	switch pt {
	case ProviderTypeOAuth:
		if p.OAuthTokenEnv == "" {
			return &ValidationError{Field: "oauth_token_env", Message: "required for oauth provider type"}
		}
	case ProviderTypeAnthropicDirect:
		if p.APIKey == "" && p.APIKeyEnv == "" {
			return &ValidationError{Field: "api_key", Message: "api_key or api_key_env required for anthropic_direct provider type"}
		}
	}
	return nil
}

// SlugToDisplayName converts a kebab-case slug to a title-case display name.
func SlugToDisplayName(slug string) string {
	parts := strings.Split(slug, "-")
	for i, part := range parts {
		if len(part) > 0 {
			parts[i] = strings.ToUpper(part[:1]) + part[1:]
		}
	}
	return strings.Join(parts, " ")
}
