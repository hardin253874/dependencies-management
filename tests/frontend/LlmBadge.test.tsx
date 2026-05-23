import { describe, expect, it, vi } from 'vitest';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { LlmBadge } from '@/components/LeftPanel/LlmBadge';

describe('LlmBadge', () => {
  it('renders provider name and model when key is set', () => {
    const onClick = vi.fn();
    render(
      <LlmBadge
        provider="anthropic"
        model="claude-opus-4-7"
        hasKey={true}
        collapsed={false}
        onClick={onClick}
      />
    );
    expect(screen.getByText('Anthropic')).toBeInTheDocument();
    expect(screen.getByText('claude-opus-4-7')).toBeInTheDocument();
  });

  it('renders Set up LLM CTA when no key', () => {
    render(
      <LlmBadge
        provider={null}
        model={null}
        hasKey={false}
        collapsed={false}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText('Set up LLM →')).toBeInTheDocument();
  });

  it('calls onClick when clicked (the click that opens Settings)', async () => {
    const onClick = vi.fn();
    render(
      <LlmBadge
        provider="anthropic"
        model="claude-opus-4-7"
        hasKey={true}
        collapsed={false}
        onClick={onClick}
      />
    );
    await userEvent.click(screen.getByTestId('llm-badge'));
    expect(onClick).toHaveBeenCalledOnce();
  });

  it('renders provider initial when collapsed', () => {
    render(
      <LlmBadge
        provider="openai"
        model="gpt-5.5"
        hasKey={true}
        collapsed={true}
        onClick={vi.fn()}
      />
    );
    expect(screen.getByText('O')).toBeInTheDocument();
  });
});
