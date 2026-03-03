import { describe, it, expect, vi } from 'vitest';
import { render, screen, fireEvent } from '@testing-library/react';
import { MaskedInput } from './MaskedInput';

describe('MaskedInput', () => {
  it('shows masked value in display mode', () => {
    render(<MaskedInput maskedValue="****abcd" onChange={vi.fn()} />);
    expect(screen.getByTestId('masked-input-display')).toHaveTextContent('****abcd');
    expect(screen.queryByTestId('masked-input-field')).not.toBeInTheDocument();
  });

  it('shows (not set) when masked value is empty', () => {
    render(<MaskedInput maskedValue="" onChange={vi.fn()} />);
    expect(screen.getByTestId('masked-input-display')).toHaveTextContent('(not set)');
  });

  it('shows Change button in display mode', () => {
    render(<MaskedInput maskedValue="****1234" onChange={vi.fn()} />);
    expect(screen.getByTestId('masked-input-toggle')).toHaveTextContent('Change');
  });

  it('switches to edit mode on Change click', () => {
    render(<MaskedInput maskedValue="****1234" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle'));
    expect(screen.getByTestId('masked-input-field')).toBeInTheDocument();
    expect(screen.queryByTestId('masked-input-display')).not.toBeInTheDocument();
  });

  it('shows Cancel button in edit mode', () => {
    render(<MaskedInput maskedValue="****1234" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle'));
    expect(screen.getByTestId('masked-input-toggle')).toHaveTextContent('Cancel');
  });

  it('calls onChange when user types new value', () => {
    const onChange = vi.fn();
    render(<MaskedInput maskedValue="****1234" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle'));
    fireEvent.change(screen.getByTestId('masked-input-field'), {
      target: { value: 'newvalue' },
    });
    expect(onChange).toHaveBeenCalledWith('newvalue');
  });

  it('cancels edit and returns to display mode on Cancel click', () => {
    const onChange = vi.fn();
    render(<MaskedInput maskedValue="****1234" onChange={onChange} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle')); // enter edit
    fireEvent.change(screen.getByTestId('masked-input-field'), {
      target: { value: 'typed' },
    });
    fireEvent.click(screen.getByTestId('masked-input-toggle')); // cancel
    expect(screen.getByTestId('masked-input-display')).toBeInTheDocument();
  });

  it('input is type=password by default in edit mode', () => {
    render(<MaskedInput maskedValue="****1234" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle'));
    expect(screen.getByTestId('masked-input-field')).toHaveAttribute('type', 'password');
  });

  it('show/hide toggle reveals plaintext', () => {
    render(<MaskedInput maskedValue="****1234" onChange={vi.fn()} />);
    fireEvent.click(screen.getByTestId('masked-input-toggle')); // enter edit
    fireEvent.click(screen.getByRole('button', { name: /show value/i }));
    expect(screen.getByTestId('masked-input-field')).toHaveAttribute('type', 'text');
  });
});
