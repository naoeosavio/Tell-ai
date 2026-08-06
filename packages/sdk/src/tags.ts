export function strip_markdown_code_blocks(text: string): string {
  return text.replace(/```[\s\S]*?```/g, '');
}

export function strip_think_tags(text: string): string {
  return text.replace(/<think>[\s\S]*?<\/think>/g, '').trim();
}

export function strip_run_tags(text: string): string {
  return text.replace(/<RUN>[\s\S]*?<\/RUN>/g, '').trim();
}

export function extract_runs(text: string): { scripts: string[]; visible: string } {
  const sanitized = strip_markdown_code_blocks(text);
  return {
    scripts: [...sanitized.matchAll(/<RUN>([\s\S]*?)<\/RUN>/g)]
      .map((match) => match[1]?.trim())
      .filter((script): script is string => Boolean(script)),
    visible: text.replace(/<RUN>[\s\S]*?<\/RUN>/g, '').trim(),
  };
}
