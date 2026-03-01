package config

import (
	"log/slog"
	"sync"
	"time"

	"github.com/fsnotify/fsnotify"
)

// FileWatcher watches files for changes with debounce support.
type FileWatcher struct {
	watcher    *fsnotify.Watcher
	callbacks  map[string]func()
	mu         sync.RWMutex
	debounce   time.Duration
	timers     map[string]*time.Timer
	done       chan struct{}
}

// NewFileWatcher creates a new file watcher with the given debounce duration.
func NewFileWatcher(debounce time.Duration) (*FileWatcher, error) {
	w, err := fsnotify.NewWatcher()
	if err != nil {
		return nil, err
	}

	fw := &FileWatcher{
		watcher:   w,
		callbacks: make(map[string]func()),
		debounce:  debounce,
		timers:    make(map[string]*time.Timer),
		done:      make(chan struct{}),
	}

	go fw.eventLoop()

	return fw, nil
}

// Watch registers a file path with a callback that fires on change.
func (fw *FileWatcher) Watch(path string, callback func()) error {
	fw.mu.Lock()
	fw.callbacks[path] = callback
	fw.mu.Unlock()

	return fw.watcher.Add(path)
}

// Stop stops all file watching and cleans up resources.
func (fw *FileWatcher) Stop() {
	close(fw.done)
	_ = fw.watcher.Close()

	fw.mu.Lock()
	for _, timer := range fw.timers {
		timer.Stop()
	}
	fw.mu.Unlock()
}

func (fw *FileWatcher) eventLoop() {
	for {
		select {
		case event, ok := <-fw.watcher.Events:
			if !ok {
				return
			}
			if event.Has(fsnotify.Write) || event.Has(fsnotify.Create) {
				fw.debouncedCallback(event.Name)
			}
		case err, ok := <-fw.watcher.Errors:
			if !ok {
				return
			}
			slog.Error("file watcher error", "error", err)
		case <-fw.done:
			return
		}
	}
}

func (fw *FileWatcher) debouncedCallback(path string) {
	fw.mu.Lock()
	defer fw.mu.Unlock()

	if timer, exists := fw.timers[path]; exists {
		timer.Stop()
	}

	callback, exists := fw.callbacks[path]
	if !exists {
		return
	}

	fw.timers[path] = time.AfterFunc(fw.debounce, callback)
}
