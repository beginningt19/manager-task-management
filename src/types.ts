export type Role = 'manager' | 'admin'
export type TaskStatus =
  | 'new'
  | 'in_progress'
  | 'waiting_external'
  | 'waiting_approval'
  | 'completed'
export type Priority = 'low' | 'normal' | 'high' | 'urgent'
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'changes_requested'
export type ChecklistKind = 'inventory' | 'deadlines' | 'custom'
export type ChecklistFieldType = 'text' | 'number' | 'date' | 'boolean' | 'select'
export type ChecklistValueData = string | number | boolean

export interface Profile {
  id: string
  display_name: string
  role: Role
  is_active: boolean
  created_at: string
  updated_at: string
}

export interface TaskRow {
  id: string
  created_by: string
  description: string
  due_at: string
  priority: Priority
  required_materials: string | null
  approval_required: boolean
  status: TaskStatus
  completed_at: string | null
  recurrence_id: string | null
  created_at: string
  updated_at: string
}

export interface TaskAssignee {
  task_id: string
  user_id: string
  assigned_by: string
  assigned_at: string
}

export interface TaskView extends TaskRow {
  assignees: Profile[]
  creator?: Profile
}

export interface ProgressUpdate {
  id: string
  task_id: string
  author_id: string
  body: string
  created_at: string
  edited_at: string | null
}

export interface LogicalFile {
  id: string
  task_id: string
  progress_update_id: string | null
  parent_type: 'task' | 'progress_update'
  display_name: string
  created_by: string
  created_at: string
  file_versions?: FileVersion[]
}

export interface FileVersion {
  id: string
  logical_file_id: string
  version_number: number
  storage_path: string
  original_name: string
  mime_type: string | null
  size_bytes: number
  uploaded_by: string
  uploaded_at: string
  sha256: string | null
}

export interface Checklist {
  id: string
  name: string
  description: string | null
  kind: ChecklistKind
  icon: string
  color: string
  created_by: string
  is_archived: boolean
  created_at: string
  updated_at: string
}

export interface ChecklistField {
  id: string
  checklist_id: string
  key: string
  label: string
  field_type: ChecklistFieldType
  is_required: boolean
  unit: string | null
  options: string[]
  settings: Record<string, unknown>
  position: number
  created_by: string
  created_at: string
  updated_at: string
}

export interface ChecklistItem {
  id: string
  checklist_id: string
  title: string
  notes: string | null
  position: number
  is_archived: boolean
  created_by: string
  created_at: string
  updated_at: string
}

export interface ChecklistValue {
  checklist_id: string
  item_id: string
  field_id: string
  value: ChecklistValueData
  updated_by: string
  updated_at: string
}

export interface ChecklistActivity {
  id: number
  checklist_id: string
  item_id: string | null
  actor_id: string | null
  action: 'insert' | 'update' | 'delete'
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
}

export interface Approval {
  id: string
  task_id: string
  requested_by: string
  reviewer_id: string | null
  status: ApprovalStatus
  request_note: string | null
  decision_note: string | null
  requested_at: string
  decided_at: string | null
}

export interface ActivityEntry {
  id: number
  task_id: string | null
  actor_id: string | null
  action: string
  entity_type: string
  entity_id: string | null
  details: Record<string, unknown>
  created_at: string
}
