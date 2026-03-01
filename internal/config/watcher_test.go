package config

import (
	"os"
	"path/filepath"
	"sync/atomic"
	"testing"
	"time"

	"github.com/stretchr/testify/assert"
	"github.com/stretchr/testify/require"
)

func TestFileWatcher_BasicWatch(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")
	require.NoError(t, os.WriteFile(path, []byte("initial"), 0644))

	fw, err := NewFileWatcher(50 * time.Millisecond)
	require.NoError(t, err)
	defer fw.Stop()

	var callCount atomic.Int32
	err = fw.Watch(path, func() {
		callCount.Add(1)
	})
	require.NoError(t, err)

	// Modify file
	time.Sleep(20 * time.Millisecond) // Let watcher settle
	require.NoError(t, os.WriteFile(path, []byte("changed"), 0644))

	// Wait for debounce + processing
	time.Sleep(200 * time.Millisecond)
	assert.GreaterOrEqual(t, callCount.Load(), int32(1))
}

func TestFileWatcher_Debounce(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")
	require.NoError(t, os.WriteFile(path, []byte("initial"), 0644))

	fw, err := NewFileWatcher(100 * time.Millisecond)
	require.NoError(t, err)
	defer fw.Stop()

	var callCount atomic.Int32
	err = fw.Watch(path, func() {
		callCount.Add(1)
	})
	require.NoError(t, err)

	time.Sleep(20 * time.Millisecond)

	// Rapid writes
	for i := 0; i < 5; i++ {
		require.NoError(t, os.WriteFile(path, []byte("change-"+string(rune('a'+i))), 0644))
		time.Sleep(10 * time.Millisecond)
	}

	// Wait for debounce
	time.Sleep(300 * time.Millisecond)
	// Should have been debounced to fewer calls than 5
	count := callCount.Load()
	assert.LessOrEqual(t, count, int32(3), "debounce should reduce callback count")
}

func TestFileWatcher_Stop(t *testing.T) {
	dir := t.TempDir()
	path := filepath.Join(dir, "test.yaml")
	require.NoError(t, os.WriteFile(path, []byte("initial"), 0644))

	fw, err := NewFileWatcher(50 * time.Millisecond)
	require.NoError(t, err)

	var callCount atomic.Int32
	err = fw.Watch(path, func() {
		callCount.Add(1)
	})
	require.NoError(t, err)

	fw.Stop()

	// Modify after stop - should not trigger
	require.NoError(t, os.WriteFile(path, []byte("after-stop"), 0644))
	time.Sleep(200 * time.Millisecond)
	assert.Equal(t, int32(0), callCount.Load())
}
