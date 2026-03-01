package api

import (
	"net/http"
	"net/http/httptest"
	"testing"
	"testing/fstest"

	"github.com/stretchr/testify/assert"
)

func newTestFS() fstest.MapFS {
	return fstest.MapFS{
		"index.html":           {Data: []byte("<html><body>SPA</body></html>")},
		"assets/main.js":       {Data: []byte("console.log('app');")},
		"assets/style.css":     {Data: []byte("body { margin: 0; }")},
	}
}

func TestSPAHandler_ServeIndexHTML(t *testing.T) {
	handler := SPAHandler(newTestFS())

	req := httptest.NewRequest(http.MethodGet, "/", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "SPA")
}

func TestSPAHandler_ServeStaticFile(t *testing.T) {
	handler := SPAHandler(newTestFS())

	req := httptest.NewRequest(http.MethodGet, "/assets/main.js", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "console.log")
}

func TestSPAHandler_ServeCSS(t *testing.T) {
	handler := SPAHandler(newTestFS())

	req := httptest.NewRequest(http.MethodGet, "/assets/style.css", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "margin")
}

func TestSPAHandler_FallbackToIndex(t *testing.T) {
	handler := SPAHandler(newTestFS())

	// Client-side route that doesn't exist as a file
	req := httptest.NewRequest(http.MethodGet, "/dashboard/settings", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "SPA")
}

func TestSPAHandler_DeepClientRoute(t *testing.T) {
	handler := SPAHandler(newTestFS())

	req := httptest.NewRequest(http.MethodGet, "/teams/my-team/agents/aid-001", nil)
	w := httptest.NewRecorder()
	handler.ServeHTTP(w, req)

	assert.Equal(t, http.StatusOK, w.Code)
	assert.Contains(t, w.Body.String(), "SPA")
}
