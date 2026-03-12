/**
 * Tasks page - task monitoring.
 */

import { useState } from 'react';
import { TaskList } from '@/components/TaskList';
import { useCreateTask } from '@/hooks/useApi';
import { Plus } from 'lucide-react';

export function Tasks() {
  const [showForm, setShowForm] = useState(false);
  const [form, setForm] = useState({
    team_slug: '',
    title: '',
    prompt: '',
  });
  const createTask = useCreateTask();

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!form.team_slug || !form.title || !form.prompt) return;

    try {
      await createTask.mutateAsync(form);
      setForm({ team_slug: '', title: '', prompt: '' });
      setShowForm(false);
    } catch (error) {
      alert(error instanceof Error ? error.message : 'Failed to create task');
    }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold">Tasks</h1>
        <button
          onClick={() => setShowForm(!showForm)}
          className="flex items-center gap-2 px-4 py-2 bg-blue-600 hover:bg-blue-700 rounded"
        >
          <Plus className="w-4 h-4" />
          New Task
        </button>
      </div>

      {/* Create task form */}
      {showForm && (
        <form onSubmit={handleSubmit} className="bg-gray-800 rounded-lg p-4 space-y-4">
          <h2 className="text-sm font-semibold text-gray-400">Create New Task</h2>
          <div className="grid gap-4">
            <div>
              <label className="block text-sm text-gray-400 mb-1">Team Slug</label>
              <input
                type="text"
                value={form.team_slug}
                onChange={(e) => setForm({ ...form, team_slug: e.target.value })}
                className="w-full bg-gray-700 text-white px-4 py-2 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Title</label>
              <input
                type="text"
                value={form.title}
                onChange={(e) => setForm({ ...form, title: e.target.value })}
                className="w-full bg-gray-700 text-white px-4 py-2 rounded"
                required
              />
            </div>
            <div>
              <label className="block text-sm text-gray-400 mb-1">Prompt</label>
              <textarea
                value={form.prompt}
                onChange={(e) => setForm({ ...form, prompt: e.target.value })}
                className="w-full bg-gray-700 text-white px-4 py-2 rounded min-h-[100px]"
                required
              />
            </div>
          </div>
          <div className="flex justify-end gap-2">
            <button
              type="button"
              onClick={() => setShowForm(false)}
              className="px-4 py-2 text-gray-400 hover:text-white"
            >
              Cancel
            </button>
            <button
              type="submit"
              disabled={createTask.isPending}
              className="px-4 py-2 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 rounded"
            >
              {createTask.isPending ? 'Creating...' : 'Create Task'}
            </button>
          </div>
        </form>
      )}

      {/* Task list */}
      <TaskList />
    </div>
  );
}