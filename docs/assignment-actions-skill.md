# assignment-actions

## Scope

This skill describes controlled assignment actions for EduAgent Agent Runtime.
It covers:

- Drafting assignment ideas from course context.
- Publishing text assignments after teacher/admin confirmation.
- Reading the current student's submission status.
- Submitting text homework after student confirmation.

V1 only supports text assignment publishing and text submission. Attachments,
batch actions, teacher-submitted student work, and cross-role delegation are out
of scope.

## Trigger Rules

Use `publish_assignment` only when a teacher or admin clearly asks to publish,
assign, or send an assignment to students. Draft-only wording such as "帮我想",
"设计一份", or "草稿" must not publish anything.

Use `submit_assignment` only when a student clearly asks to submit homework and
provides both the target assignment id and text content.

Use existing read tools for status questions such as "我还有哪些作业没交" or
"这个作业交了吗".

## Tool Contracts

`publish_assignment`

- Roles: `TEACHER`, `ADMIN`
- Required args: `course_id`, `title`
- Optional args: `description`, `detail`, `due_date`, `total_points`,
  `peer_review_enabled`, `peer_review_open_at`, `peer_review_close_at`,
  `peer_review_required_count`, `peer_review_bonus_per_review`,
  `peer_review_bonus_cap`, `peer_review_prompt`
- Requires confirmation: yes
- Implementation: `TeacherService.create_assignment(AssignmentCreate, user)`

`submit_assignment`

- Roles: `STUDENT`
- Required args: `assignment_id`, `content`
- Optional args: `file_ids`, `file_name`, `file_path`
- Requires confirmation: yes
- Implementation: `StudentService.submit_assignment(...)`

## Confirmation Rules

Write operations must stop at `WAITING_CONFIRMATION` on the first request. The
confirmation card should show the key parameters:

- Publishing: course, title, due date, total points, description/detail summary.
- Submitting: assignment id/title when known, content summary, file list.

Only execute when the follow-up request includes `confirm=true`.

## Failure Replies

If required parameters are missing, ask for the specific missing fields and do
not execute a write tool.

If the current role is not allowed, explain the role boundary.

If service validation fails, state that the action was not completed and include
the business reason returned by the service.
