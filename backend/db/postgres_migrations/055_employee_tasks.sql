CREATE SEQUENCE IF NOT EXISTS employee_task_number_seq;

CREATE TABLE IF NOT EXISTS employee_tasks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  task_number VARCHAR(24) NOT NULL UNIQUE
    DEFAULT ('IT-TASK-' || lpad(nextval('employee_task_number_seq')::text, 6, '0')),
  entity_id UUID NOT NULL REFERENCES entities(id) ON DELETE RESTRICT,
  title VARCHAR(200) NOT NULL CHECK (char_length(btrim(title)) BETWEEN 1 AND 200),
  description TEXT NOT NULL DEFAULT '' CHECK (char_length(description) <= 4000),
  status VARCHAR(16) NOT NULL DEFAULT 'pending'
    CHECK (status IN ('pending', 'in_progress', 'completed', 'cancelled')),
  priority VARCHAR(16) NOT NULL DEFAULT 'medium'
    CHECK (priority IN ('low', 'medium', 'high', 'critical')),
  assignee_id UUID REFERENCES users(id) ON DELETE SET NULL,
  created_by UUID NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  due_date DATE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_employee_tasks_entity_assignee_status
  ON employee_tasks (entity_id, assignee_id, status, updated_at DESC);
CREATE INDEX IF NOT EXISTS idx_employee_tasks_created
  ON employee_tasks (created_at DESC);
