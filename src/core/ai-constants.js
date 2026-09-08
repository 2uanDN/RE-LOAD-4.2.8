// Registry for AI model behaviors and syntax variants

// Global Tag Registry for Reasoning (Adapter Pattern)
export const REASONING_TAGS = ['block_0_thinking', 'think', 'thinking', 'thought', 'reasoning'];

// Construct dynamic regex for End-Of-String (EOS) cleanup 
// This creates: /<(block_0_thinking|think|thinking|thought|reasoning)>[\s\S]*?(?:<\/\1>|$)/gi
export const REASONING_CLEANUP_REGEX = new RegExp(
  `(?:<(${REASONING_TAGS.join('|')})>)[\\s\\S]*?(?:<\\/\\1>|$)`, 
  'gi'
);

export const getReasoningStartRegex = () => new RegExp(`^<(${REASONING_TAGS.join('|')})>`);
export const getReasoningEndRegex = (tag) => new RegExp(`^</${tag}>`);
