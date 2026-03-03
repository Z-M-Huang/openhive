package domain

import (
	"fmt"
	"regexp"
	"strings"
)

const maxSlugLength = 63

var (
	aidPattern  = regexp.MustCompile(`^aid-[a-z0-9]+-[a-z0-9]+$`)
	tidPattern  = regexp.MustCompile(`^tid-[a-z0-9]+-[a-z0-9]+$`)
	slugPattern = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)

	// JID pattern map for each channel prefix.
	jidPatterns = map[string]*regexp.Regexp{
		"discord":  regexp.MustCompile(`^discord:[0-9]+:[0-9]+$`),
		"whatsapp": regexp.MustCompile(`^whatsapp:[0-9]+$`),
		"api":      regexp.MustCompile(`^api:[0-9]+$`),
		"cli":      regexp.MustCompile(`^cli:.+$`),
	}
)

// KnownJIDPrefixes returns the list of known JID prefix strings.
func KnownJIDPrefixes() []string {
	prefixes := make([]string, 0, len(jidPatterns))
	for k := range jidPatterns {
		prefixes = append(prefixes, k)
	}
	return prefixes
}

// ValidateJIDPrefix checks that a JID prefix is known.
func ValidateJIDPrefix(prefix string) error {
	if _, ok := jidPatterns[prefix]; !ok {
		return &ValidationError{Field: "jid_prefix", Message: fmt.Sprintf("unknown JID prefix: %q", prefix)}
	}
	return nil
}

// ValidateJID checks that a JID matches the expected format for its channel type.
func ValidateJID(jid string) error {
	if jid == "" {
		return &ValidationError{Field: "jid", Message: "cannot be empty"}
	}

	colonIdx := strings.Index(jid, ":")
	if colonIdx == -1 {
		return &ValidationError{Field: "jid", Message: "must have format <prefix>:<value>"}
	}

	prefix := jid[:colonIdx]
	pattern, ok := jidPatterns[prefix]
	if !ok {
		return &ValidationError{Field: "jid", Message: fmt.Sprintf("unknown JID prefix: %q", prefix)}
	}

	if !pattern.MatchString(jid) {
		return &ValidationError{Field: "jid", Message: fmt.Sprintf("invalid JID format for prefix %q", prefix)}
	}

	return nil
}

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
// Rejects: empty strings, strings containing '..' (path traversal), strings
// containing '/' or '\' (path separators), strings longer than 63 characters,
// and strings not matching ^[a-z0-9]+(-[a-z0-9]+)*$.
func ValidateSlug(slug string) error {
	if slug == "" {
		return &ValidationError{Field: "slug", Message: "cannot be empty"}
	}
	if len(slug) > maxSlugLength {
		return &ValidationError{Field: "slug", Message: fmt.Sprintf("must be at most %d characters", maxSlugLength)}
	}
	if strings.Contains(slug, "..") {
		return &ValidationError{Field: "slug", Message: "must not contain '..' (path traversal)"}
	}
	if strings.ContainsAny(slug, "/\\") {
		return &ValidationError{Field: "slug", Message: "must not contain path separators"}
	}
	if !slugPattern.MatchString(slug) {
		return &ValidationError{Field: "slug", Message: "must be lowercase letters, numbers, and hyphens only (no leading/trailing/consecutive hyphens)"}
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
		if p.OAuthToken == "" {
			return &ValidationError{Field: "oauth_token", Message: "required for oauth provider type"}
		}
	case ProviderTypeAnthropicDirect:
		if p.APIKey == "" {
			return &ValidationError{Field: "api_key", Message: "required for anthropic_direct provider type"}
		}
	}
	return nil
}

// reservedSlugs is the set of slugs that cannot be used as team names.
// These are reserved for internal use by the platform.
var reservedSlugs = map[string]bool{
	"main":     true,
	"admin":    true,
	"system":   true,
	"root":     true,
	"openhive": true,
}

// IsReservedSlug reports whether the given slug is reserved by the platform
// and must not be used as a user-defined team name.
func IsReservedSlug(slug string) bool {
	return reservedSlugs[slug]
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
