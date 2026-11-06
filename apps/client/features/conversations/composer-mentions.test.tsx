import { useState } from 'react';
import { Platform } from 'react-native';
import { fireEvent, render, screen } from '@testing-library/react-native';
import { DisplayProvider } from '@knowscroll/ui';
import { Composer } from './composer';
import { insertMention, mentionedOption, mentionQuery, type MentionOption } from './mention-input';

const residents: readonly MentionOption[] = [
  { id: 'explainer', name: 'Nova', label: 'AI · Explainer' },
  { id: 'skeptic', name: 'Halley', label: 'AI · Skeptic' },
];

function Draft({
  onSend,
  options = residents,
}: {
  readonly onSend: (text: string) => void;
  readonly options?: readonly MentionOption[];
}) {
  const [value, setValue] = useState('');
  return (
    <DisplayProvider value={{ width: 390, textScale: 1, reducedMotion: true }}>
      <Composer name="General" value={value} onChange={setValue} onSend={onSend} mentions={options} />
    </DisplayProvider>
  );
}

it('uses whole recipient boundaries and replaces only the token at the caret', () => {
  expect(mentionQuery('mail asha@nova.example', 10)).toBeUndefined();
  const text = 'hello @No and the rest';
  expect(insertMention(text, mentionQuery(text, 9)!, 'Nova')).toEqual({ text: 'hello @Nova and the rest', caret: 12 });
  expect(mentionedOption('@Novae is not Nova', residents)).toBeUndefined();
  expect(mentionedOption('@Halley and @Nova', residents)?.name).toBe('Halley');
  expect(mentionedOption('@Someone', residents)).toBeUndefined();
});

it('filters the actual roster, inserts on touch and shows its AI target without sending', async () => {
  const send = jest.fn();
  await render(<Draft onSend={send} options={[{ id: 'custom', name: 'Vega', label: 'AI · Explainer' }]} />);
  const input = screen.getByLabelText('Message General');
  await fireEvent(input, 'focus');
  await fireEvent.changeText(input, '@');
  expect(screen.getByLabelText('AI residents to mention')).toBeOnTheScreen();
  expect(screen.queryByText('@Nova')).not.toBeOnTheScreen();
  await fireEvent.changeText(input, '@ve');
  await fireEvent.press(screen.getByLabelText('Mention Vega, AI · Explainer'));
  expect(input.props.value).toBe('@Vega ');
  expect(screen.getByText('To Vega · AI · Explainer')).toBeOnTheScreen();
  expect(send).not.toHaveBeenCalled();
  await fireEvent.changeText(input, '@Vega how are you');
  await fireEvent.press(screen.getByLabelText('Send message'));
  expect(send).toHaveBeenCalledTimes(1);
  expect(send).toHaveBeenCalledWith('@Vega how are you');
});

it('shows unavailable residents and never picks or commissions them', async () => {
  const send = jest.fn();
  await render(<Draft onSend={send} options={[{ ...residents[0]!, disabled: true, status: 'Room is paused' }]} />);
  const input = screen.getByLabelText('Message General');
  await fireEvent(input, 'focus');
  await fireEvent.changeText(input, '@');
  expect(screen.getByText('Room is paused')).toBeOnTheScreen();
  expect(screen.getByLabelText('Mention Nova, AI · Explainer, Room is paused')).toBeDisabled();
  expect(send).not.toHaveBeenCalled();
});

it('selects by keyboard instead of sending, and Escape dismisses without deleting the draft', async () => {
  const original = Platform.OS;
  Object.defineProperty(Platform, 'OS', { configurable: true, value: 'web' });
  try {
    const send = jest.fn();
    await render(<Draft onSend={send} />);
    const input = screen.getByLabelText('Message General');
    await fireEvent(input, 'focus');
    await fireEvent.changeText(input, '@');
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'ArrowDown' }, preventDefault: jest.fn() });
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'Enter' }, preventDefault: jest.fn() });
    expect(input.props.value).toBe('@Halley ');
    expect(send).not.toHaveBeenCalled();
    await fireEvent.changeText(input, '@N');
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'Escape' }, preventDefault: jest.fn() });
    expect(screen.queryByLabelText('AI residents to mention')).not.toBeOnTheScreen();
    expect(input.props.value).toBe('@N');
    await fireEvent.changeText(input, '@No');
    const preventDefault = jest.fn();
    await fireEvent(input, 'keyPress', { nativeEvent: { key: 'Tab', shiftKey: true }, preventDefault });
    expect(preventDefault).not.toHaveBeenCalled();
    expect(screen.queryByLabelText('AI residents to mention')).not.toBeOnTheScreen();
  } finally {
    Object.defineProperty(Platform, 'OS', { configurable: true, value: original });
  }
});
