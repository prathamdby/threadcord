export function formatToolValidationError(params: {
  toolName: string;
  issues: ReadonlyArray<{
    path?: ReadonlyArray<string | number | symbol>;
    message: string;
  }>;
  requiredReminder: string;
}): string {
  const lines = [`${params.toolName} validation failed:`];
  for (const issue of params.issues) {
    const path =
      issue.path && issue.path.length > 0
        ? issue.path.map(String).join(".")
        : "(root)";
    lines.push(`- ${path}: ${issue.message}`);
  }
  lines.push(params.requiredReminder);
  lines.push(
    `Fix the fields above and call ${params.toolName} again. Do not resend the same payload.`,
  );
  return lines.join("\n");
}
