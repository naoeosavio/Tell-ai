export type AgentNotification = {
  label: string;
  title: string;
};

export type AgentNotificationInput = {
  is_agent_visible: boolean;
  pending_command: string | null;
  error_count: number;
};

export function resolve_agent_notification(input: AgentNotificationInput): AgentNotification | null {
  if (input.is_agent_visible) {
    return null;
  } else if (input.pending_command) {
    return { label: '!', title: 'Command awaiting authorization' };
  } else if (input.error_count > 0) {
    return {
      label: String(input.error_count),
      title: `${input.error_count} Agent Feed error(s)`,
    };
  } else {
    return null;
  }
}
