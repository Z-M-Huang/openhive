package store

import (
	"context"

	"github.com/Z-M-Huang/openhive/internal/domain"
	"gorm.io/gorm"
)

const defaultSubtreeMaxDepth = 100

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

// CreateWithTx inserts a new task using the provided transaction.
func (s *TaskStoreImpl) CreateWithTx(tx *gorm.DB, task *domain.Task) error {
	model := TaskModelFromDomain(task)
	return tx.Create(model).Error
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

// Update modifies an existing task using partial column updates.
func (s *TaskStoreImpl) Update(_ context.Context, task *domain.Task) error {
	updates := map[string]interface{}{
		"parent_id":    task.ParentID,
		"team_slug":    task.TeamSlug,
		"agent_aid":    task.AgentAID,
		"jid":          task.JID,
		"status":       int(task.Status),
		"prompt":       task.Prompt,
		"result":       task.Result,
		"error":        task.Error,
		"updated_at":   task.UpdatedAt,
		"completed_at": task.CompletedAt,
	}
	result := s.db.Writer.Model(&TaskModel{}).Where("id = ?", task.ID).Updates(updates)
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

// ListByTeam returns all tasks for a given team, ordered by created_at DESC.
func (s *TaskStoreImpl) ListByTeam(_ context.Context, teamSlug string) ([]*domain.Task, error) {
	var models []TaskModel
	if err := s.db.Reader.Where("team_slug = ?", teamSlug).Order("created_at DESC").Find(&models).Error; err != nil {
		return nil, err
	}
	return toTaskDomainSlice(models), nil
}

// ListByTeamPaginated returns paginated tasks for a given team.
// Returns tasks, total count, and any error.
func (s *TaskStoreImpl) ListByTeamPaginated(_ context.Context, teamSlug string, limit, offset int) ([]*domain.Task, int64, error) {
	var models []TaskModel
	var total int64

	q := s.db.Reader.Model(&TaskModel{}).Where("team_slug = ?", teamSlug)
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Order("created_at DESC").Limit(limit).Offset(offset).Find(&models).Error; err != nil {
		return nil, 0, err
	}
	return toTaskDomainSlice(models), total, nil
}

// ListByStatus returns all tasks with a given status.
func (s *TaskStoreImpl) ListByStatus(_ context.Context, status domain.TaskStatus) ([]*domain.Task, error) {
	var models []TaskModel
	if err := s.db.Reader.Where("status = ?", int(status)).Order("created_at DESC").Find(&models).Error; err != nil {
		return nil, err
	}
	return toTaskDomainSlice(models), nil
}

// ListByStatusPaginated returns paginated tasks with a given status.
// Returns tasks, total count, and any error.
func (s *TaskStoreImpl) ListByStatusPaginated(_ context.Context, status domain.TaskStatus, limit, offset int) ([]*domain.Task, int64, error) {
	var models []TaskModel
	var total int64

	q := s.db.Reader.Model(&TaskModel{}).Where("status = ?", int(status))
	if err := q.Count(&total).Error; err != nil {
		return nil, 0, err
	}
	if err := q.Order("created_at DESC").Limit(limit).Offset(offset).Find(&models).Error; err != nil {
		return nil, 0, err
	}
	return toTaskDomainSlice(models), total, nil
}

// GetSubtree returns all tasks in the subtree rooted at the given task ID.
// maxDepth limits the recursion depth (0 = default 100).
func (s *TaskStoreImpl) GetSubtree(_ context.Context, rootID string) ([]*domain.Task, error) {
	return s.GetSubtreeWithDepth(rootID, defaultSubtreeMaxDepth)
}

// GetSubtreeWithDepth returns the subtree with an explicit depth limit.
func (s *TaskStoreImpl) GetSubtreeWithDepth(rootID string, maxDepth int) ([]*domain.Task, error) {
	if maxDepth <= 0 {
		maxDepth = defaultSubtreeMaxDepth
	}
	var models []TaskModel

	// Recursive CTE with depth tracking and LIMIT on depth
	query := `
		WITH RECURSIVE subtree(id, parent_id, team_slug, agent_aid, jid, status, prompt, result, error, created_at, updated_at, completed_at, depth) AS (
			SELECT id, parent_id, team_slug, agent_aid, jid, status, prompt, result, error, created_at, updated_at, completed_at, 0
			FROM tasks WHERE id = ?
			UNION ALL
			SELECT t.id, t.parent_id, t.team_slug, t.agent_aid, t.jid, t.status, t.prompt, t.result, t.error, t.created_at, t.updated_at, t.completed_at, s.depth + 1
			FROM tasks t
			INNER JOIN subtree s ON t.parent_id = s.id
			WHERE s.depth < ?
		)
		SELECT id, parent_id, team_slug, agent_aid, jid, status, prompt, result, error, created_at, updated_at, completed_at FROM subtree
	`

	if err := s.db.Reader.Raw(query, rootID, maxDepth).Scan(&models).Error; err != nil {
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
