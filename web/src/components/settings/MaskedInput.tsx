import { useState } from 'react';
import { Eye, EyeOff } from 'lucide-react';
import { cn } from '../../lib/utils';

interface MaskedInputProps {
  /** The current masked value to display (e.g. '****1234') */
  maskedValue: string;
  /** Called with the new plaintext value when the user edits */
  onChange: (value: string) => void;
  placeholder?: string;
  className?: string;
  id?: string;
}

/**
 * MaskedInput: shows a masked value (e.g. '****1234') and allows entering a new value.
 * When the user clicks the input, they can type a new plaintext value.
 * The masked value is never decoded — the server always returns masked values.
 */
export function MaskedInput({
  maskedValue,
  onChange,
  placeholder = 'Enter new value...',
  className,
  id,
}: MaskedInputProps): React.JSX.Element {
  const [isEditing, setIsEditing] = useState(false);
  const [newValue, setNewValue] = useState('');
  const [showValue, setShowValue] = useState(false);

  const handleEditToggle = (): void => {
    if (isEditing) {
      // Cancel edit - revert to showing masked value
      setIsEditing(false);
      setNewValue('');
      setShowValue(false);
    } else {
      setIsEditing(true);
    }
  };

  const handleChange = (e: React.ChangeEvent<HTMLInputElement>): void => {
    const val = e.target.value;
    setNewValue(val);
    onChange(val);
  };

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {isEditing ? (
        <div className="flex items-center gap-1 flex-1">
          <input
            id={id}
            type={showValue ? 'text' : 'password'}
            value={newValue}
            onChange={handleChange}
            placeholder={placeholder}
            className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
            autoFocus
            data-testid="masked-input-field"
          />
          <button
            type="button"
            onClick={() => setShowValue(prev => !prev)}
            className="p-2 text-muted-foreground hover:text-foreground"
            aria-label={showValue ? 'Hide value' : 'Show value'}
          >
            {showValue ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
          </button>
        </div>
      ) : (
        <span
          className="flex-1 rounded-md border border-input bg-muted px-3 py-2 text-sm font-mono text-muted-foreground"
          data-testid="masked-input-display"
        >
          {maskedValue || '(not set)'}
        </span>
      )}
      <button
        type="button"
        onClick={handleEditToggle}
        className="text-xs text-muted-foreground hover:text-foreground underline"
        data-testid="masked-input-toggle"
      >
        {isEditing ? 'Cancel' : 'Change'}
      </button>
    </div>
  );
}
