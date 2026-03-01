package logging

import (
	"compress/gzip"
	"context"
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"time"

	"github.com/Z-M-Huang/openhive/internal/domain"
)

const (
	archiveBatchSize    = 1000
	archiveCheckInterval = 5 * time.Minute
	dirPermissions      = 0700
	filePermissions     = 0600
)

// Archiver manages log archive operations: exporting oldest entries to .json.gz
// files and rotating old archives.
type Archiver struct {
	store      domain.LogStore
	cfg        domain.ArchiveConfig
	logger     *slog.Logger
	stopCh     chan struct{}
	doneCh     chan struct{}
}

// NewArchiver creates a new Archiver.
func NewArchiver(store domain.LogStore, cfg domain.ArchiveConfig, logger *slog.Logger) *Archiver {
	return &Archiver{
		store:  store,
		cfg:    cfg,
		logger: logger,
		stopCh: make(chan struct{}),
		doneCh: make(chan struct{}),
	}
}

// Start begins the archive goroutine that periodically checks and archives old logs.
func (a *Archiver) Start() {
	go a.run()
}

// Stop signals the archive goroutine to stop and waits for it to finish.
func (a *Archiver) Stop() {
	close(a.stopCh)
	<-a.doneCh
}

func (a *Archiver) run() {
	defer close(a.doneCh)

	ticker := time.NewTicker(archiveCheckInterval)
	defer ticker.Stop()

	for {
		select {
		case <-a.stopCh:
			return
		case <-ticker.C:
			a.archiveOnce()
		}
	}
}

// ArchiveOnce performs a single archive check and export. Exported for testing.
func (a *Archiver) ArchiveOnce() {
	a.archiveOnce()
}

func (a *Archiver) archiveOnce() {
	if !a.cfg.Enabled {
		return
	}

	ctx := context.Background()

	count, err := a.store.Count(ctx)
	if err != nil {
		a.logger.Error("archive: failed to count logs", "error", err)
		return
	}

	if count <= int64(a.cfg.MaxEntries) {
		return
	}

	// Get oldest entries for archiving
	entries, err := a.store.GetOldest(ctx, archiveBatchSize)
	if err != nil {
		a.logger.Error("archive: failed to get oldest entries", "error", err)
		return
	}

	if len(entries) == 0 {
		return
	}

	// Ensure archive directory exists
	archiveDir := a.cfg.ArchiveDir
	if archiveDir == "" {
		archiveDir = "data/archives"
	}

	err = os.MkdirAll(archiveDir, dirPermissions)
	if err != nil {
		a.logger.Error("archive: failed to create archive directory", "error", err, "dir", archiveDir)
		return
	}

	// Write archive file
	filename := fmt.Sprintf("logs-%s.json.gz", time.Now().UTC().Format("20060102-150405"))
	filePath := filepath.Join(archiveDir, filename)

	err = a.writeArchiveFile(filePath, entries)
	if err != nil {
		a.logger.Error("archive: failed to write archive file", "error", err, "path", filePath)
		return
	}

	// Delete archived entries from DB
	oldest := entries[len(entries)-1]
	var deleted int64
	deleted, err = a.store.DeleteBefore(ctx, oldest.CreatedAt.Add(time.Millisecond))
	if err != nil {
		a.logger.Error("archive: failed to delete archived entries", "error", err)
		return
	}

	a.logger.Info("archive: exported and deleted logs",
		"archived", len(entries),
		"deleted", deleted,
		"file", filePath,
	)

	// Rotate old archives
	a.rotate(archiveDir)
}

func (a *Archiver) writeArchiveFile(path string, entries []*domain.LogEntry) error {
	f, err := os.OpenFile(path, os.O_CREATE|os.O_WRONLY|os.O_EXCL, filePermissions)
	if err != nil {
		return fmt.Errorf("failed to create archive file: %w", err)
	}
	defer f.Close()

	gw, err := gzip.NewWriterLevel(f, gzip.BestSpeed)
	if err != nil {
		return fmt.Errorf("failed to create gzip writer: %w", err)
	}
	defer gw.Close()

	enc := json.NewEncoder(gw)
	for _, entry := range entries {
		if err := enc.Encode(entry); err != nil {
			return fmt.Errorf("failed to encode log entry: %w", err)
		}
	}

	return nil
}

func (a *Archiver) rotate(archiveDir string) {
	if a.cfg.KeepCopies <= 0 {
		return
	}

	dirEntries, err := os.ReadDir(archiveDir)
	if err != nil {
		a.logger.Error("archive: failed to read archive directory", "error", err)
		return
	}

	var archives []string
	for _, e := range dirEntries {
		if !e.IsDir() && strings.HasPrefix(e.Name(), "logs-") && strings.HasSuffix(e.Name(), ".json.gz") {
			archives = append(archives, e.Name())
		}
	}

	sort.Strings(archives)

	for len(archives) > a.cfg.KeepCopies {
		oldest := archives[0]
		archives = archives[1:]
		path := filepath.Join(archiveDir, oldest)
		if err := os.Remove(path); err != nil {
			a.logger.Error("archive: failed to remove old archive", "error", err, "path", path)
		} else {
			a.logger.Info("archive: rotated old archive", "path", path)
		}
	}
}
