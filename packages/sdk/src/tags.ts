export function strip_markdown_code_blocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

export function strip_think_tags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
}

export function strip_run_tags(text: string): string {
  return text.replace(/<RUN>[\s\S]*?<\/RUN>/gi, '').trim();
}

export function sanitize_reasoning(text: string): string {
  return text.replace(/</g, '‹').replace(/>/g, '›');
}

export function extract_runs(text: string): { scripts: string[]; visible: string } {
  const sanitized = strip_markdown_code_blocks(text);
  const match = /<RUN>([\s\S]*?)<\/RUN>/i.exec(sanitized);
  const script = match?.[1]?.trim();
  return {
    scripts: script ? [script] : [],
    visible: text.replace(/<RUN>[\s\S]*?<\/RUN>/gi, '').trim(),
  };
}
