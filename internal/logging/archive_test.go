package logging

import (
	"bytes"
	"compress/gzip"
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"os"
	"path/filepath"
	"testing"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"github.com/Z-M-Huang/openhive/internal/store"
	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func setupArchiveTest(t *testing.T) (domain.LogStore, *Archiver, string) {
	t.Helper()
	db, err := store.NewInMemoryDB()
	require.NoError(t, err)
	t.Cleanup(func() { db.Close() })

	logStore := store.NewLogStore(db)
	archiveDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	cfg := domain.ArchiveConfig{
		Enabled:    true,
		MaxEntries: 10,
		KeepCopies: 3,
		ArchiveDir: archiveDir,
	}

	archiver := NewArchiver(logStore, cfg, logger)
	return logStore, archiver, archiveDir
}

func insertLogEntries(t *testing.T, s domain.LogStore, count int) {
	t.Helper()
	entries := make([]*domain.LogEntry, count)
	for i := range count {
		entries[i] = &domain.LogEntry{
			Level:     domain.LogLevelInfo,
			Component: "test",
			Action:    "test_action",
			Message:   "test message",
			CreatedAt: time.Now().Add(-time.Duration(count-i) * time.Second),
		}
	}
	require.NoError(t, s.Create(context.Background(), entries))
}

func TestArchiver_ExportsToGzipFile(t *testing.T) {
	logStore, archiver, archiveDir := setupArchiveTest(t)

	// Insert more than MaxEntries (10) entries
	insertLogEntries(t, logStore, 20)

	archiver.ArchiveOnce()

	// Check archive file was created
	dirEntries, err := os.ReadDir(archiveDir)
	require.NoError(t, err)
	assert.Len(t, dirEntries, 1)
	assert.Contains(t, dirEntries[0].Name(), "logs-")
	assert.Contains(t, dirEntries[0].Name(), ".json.gz")

	// Verify it's valid gzip JSON
	f, err := os.Open(filepath.Join(archiveDir, dirEntries[0].Name()))
	require.NoError(t, err)
	defer f.Close()

	gr, err := gzip.NewReader(f)
	require.NoError(t, err)
	defer gr.Close()

	data, err := io.ReadAll(gr)
	require.NoError(t, err)
	assert.NotEmpty(t, data)

	// Each line should be a valid JSON log entry
	dec := json.NewDecoder(bytes.NewReader(data))
	var entryCount int
	for dec.More() {
		var entry domain.LogEntry
		require.NoError(t, dec.Decode(&entry))
		entryCount++
	}
	assert.Equal(t, 20, entryCount, "should export all 20 entries (fewer than archiveBatchSize)")
}

func TestArchiver_DeletesArchivedEntries(t *testing.T) {
	logStore, archiver, _ := setupArchiveTest(t)

	insertLogEntries(t, logStore, 20)

	countBefore, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Equal(t, int64(20), countBefore)

	archiver.ArchiveOnce()

	countAfter, err := logStore.Count(context.Background())
	require.NoError(t, err)
	assert.Less(t, countAfter, countBefore)
}

func TestArchiver_Rotation(t *testing.T) {
	logStore, archiver, archiveDir := setupArchiveTest(t)

	// Create 5 archive runs, only 3 should be kept
	for i := range 5 {
		insertLogEntries(t, logStore, 20)
		archiver.ArchiveOnce()
		// Small delay to ensure unique filenames
		_ = i
		time.Sleep(time.Second)
	}

	dirEntries, err := os.ReadDir(archiveDir)
	require.NoError(t, err)
	assert.LessOrEqual(t, len(dirEntries), 3, "should keep at most 3 copies")
}

func TestArchiver_DisabledNoOp(t *testing.T) {
	db, err := store.NewInMemoryDB()
	require.NoError(t, err)
	defer db.Close()

	logStore := store.NewLogStore(db)
	archiveDir := t.TempDir()
	logger := slog.New(slog.NewTextHandler(&bytes.Buffer{}, nil))

	cfg := domain.ArchiveConfig{
		Enabled:    false,
		MaxEntries: 10,
		ArchiveDir: archiveDir,
	}

	archiver := NewArchiver(logStore, cfg, logger)
	insertLogEntries(t, logStore, 20)

	archiver.ArchiveOnce()

	dirEntries, err := os.ReadDir(archiveDir)
	require.NoError(t, err)
	assert.Empty(t, dirEntries, "disabled archiver should not create files")
}

func TestArchiver_BelowThresholdNoOp(t *testing.T) {
	logStore, archiver, archiveDir := setupArchiveTest(t)

	insertLogEntries(t, logStore, 5)

	archiver.ArchiveOnce()

	dirEntries, err := os.ReadDir(archiveDir)
	require.NoError(t, err)
	assert.Empty(t, dirEntries, "below threshold should not archive")
}

func TestArchiver_StartStop(t *testing.T) {
	_, archiver, _ := setupArchiveTest(t)

	archiver.Start()
	// Stop immediately; should not hang
	archiver.Stop()
}

func TestArchiver_FilePermissions(t *testing.T) {
	logStore, archiver, archiveDir := setupArchiveTest(t)

	insertLogEntries(t, logStore, 20)
	archiver.ArchiveOnce()

	dirEntries, err := os.ReadDir(archiveDir)
	require.NoError(t, err)
	require.NotEmpty(t, dirEntries)

	info, err := dirEntries[0].Info()
	require.NoError(t, err)
	// File should have mode 0600
	assert.Equal(t, os.FileMode(0600), info.Mode().Perm())
}
