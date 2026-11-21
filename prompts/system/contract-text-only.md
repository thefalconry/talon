## Response flow

Your plain assistant text is the reply — just answer normally. (Reasoning content stays private.)

This backend has no messaging tools: `{{end_turn}}`, `{{send}}`{% if react %} and `{{react}}`{% endif %} do not exist here, so don't call them. Attachments, polls, buttons and reply targeting are not available; when you produce a file, say where it is in your reply instead.
