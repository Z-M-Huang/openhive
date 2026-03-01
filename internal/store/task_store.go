package store

import (
	"context"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gorm.io/gorm"
)

// TaskStoreImpl implements domain.TaskStore using GORM.
type TaskStoreImpl struct {
	db *DB
}

// NewTaskStore creates a new TaskStore.
func NewTaskStore(db *DB) *TaskStoreImpl {
	return &TaskStoreImpl{db: db}
}

// Create inserts a new task into the database.
func (s *TaskStoreImpl) Create(_ context.Context, task *domain.Task) error {
	model := TaskModelFromDomain(task)
	return s.db.Writer.Create(model).Error
}

// Get retrieves a task by ID.
func (s *TaskStoreImpl) Get(_ context.Context, id string) (*domain.Task, error) {
	var model TaskModel
	if err := s.db.Reader.Where("id = ?", id).First(&model).Error; err != nil {
		if err == gorm.ErrRecordNotFound {
			return nil, &domain.NotFoundError{Resource: "task", ID: id}
		}
		return nil, err
	}
	return model.ToDomain(), nil
}

// Update modifies an existing task.
func (s *TaskStoreImpl) Update(_ context.Context, task *domain.Task) error {
	model := TaskModelFromDomain(task)
	result := s.db.Writer.Save(model)
	if result.Error != nil {
		return result.Error
	}
	if result.RowsAffected == 0 {
		return &domain.NotFoundError{Resource: "task", ID: task.ID}
	}
	return nil
}

// Delete removes a task by ID.
func (s *TaskStoreImpl) Delete(_ context.Context, id string) error {
	result := s.db.Writer.Where("id = ?", id).Delete(&TaskModel{})
	if result.Error != nil {
		return result.Error
	}
	return nil
}

// ListByTeam returns all tasks for a given team.
func (s *TaskStoreImpl) ListByTeam(_ context.Context, teamSlug string) ([]*domain.Task, error) {
	var models []TaskModel
	if err := s.db.Reader.Where("team_slug = ?", teamSlug).Order("created_at DESC").Find(&models).Error; err != nil {
		return nil, err
	}
	return toTaskDomainSlice(models), nil
}

// ListByStatus returns all tasks with a given status.
func (s *TaskStoreImpl) ListByStatus(_ context.Context, status domain.TaskStatus) ([]*domain.Task, error) {
	var models []TaskModel
	if err := s.db.Reader.Where("status = ?", int(status)).Order("created_at DESC").Find(&models).Error; err != nil {
		return nil, err
	}
	return toTaskDomainSlice(models), nil
}

// GetSubtree returns all tasks in the subtree rooted at the given task ID.
func (s *TaskStoreImpl) GetSubtree(_ context.Context, rootID string) ([]*domain.Task, error) {
	var models []TaskModel

	// Use recursive CTE for task DAG traversal
	query := `
		WITH RECURSIVE subtree AS (
			SELECT * FROM tasks WHERE id = ?
			UNION ALL
			SELECT t.* FROM tasks t
			INNER JOIN subtree s ON t.parent_id = s.id
		)
		SELECT * FROM subtree
	`

	if err := s.db.Reader.Raw(query, rootID).Scan(&models).Error; err != nil {
		return nil, err
	}

	return toTaskDomainSlice(models), nil
}

func toTaskDomainSlice(models []TaskModel) []*domain.Task {
	tasks := make([]*domain.Task, len(models))
	for i := range models {
		tasks[i] = models[i].ToDomain()
	}
	return tasks
}
