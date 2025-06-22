import React from 'react';
import { render, screen, fireEvent, waitFor } from '@testing-library/react';
import '@testing-library/jest-dom';

// Mock react-router-dom
jest.mock('react-router-dom', () => ({
    Link: ({ children, to, ...props }) => <a href={to} {...props}>{children}</a>
}));

// Mock Chakra UI useToast
const mockToast = jest.fn();
jest.mock('@chakra-ui/react', () => {
    const actual = jest.requireActual('@chakra-ui/react');
    return {
        __esModule: true,
        ...actual,
        useToast: () => mockToast,
    };
});

import DescriptionEntry from '../src/DescriptionEntry/DescriptionEntry.jsx';

describe('DescriptionEntry component', () => {
    beforeEach(() => {
        jest.clearAllMocks();
        fetch.mockClear();
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('Initial Render', () => {
        it('renders the main elements correctly', async () => {
            // Mock successful entries fetch
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: [] })
            });

            render(<DescriptionEntry />);

            expect(screen.getByText('Log an Event')).toBeInTheDocument();
            expect(screen.getByText('What happened?')).toBeInTheDocument();
            expect(screen.getByPlaceholderText('Type your event description here...')).toBeInTheDocument();
            expect(screen.getByText('Press Enter to log event')).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /clear/i })).toBeInTheDocument();
            expect(screen.getByRole('button', { name: /log event/i })).toBeInTheDocument();
            expect(screen.getByRole('link', { name: /back to home/i })).toBeInTheDocument();

            // Wait for the loading to complete
            await waitFor(() => {
                expect(fetch).toHaveBeenCalledWith('/api/entries?limit=10');
            });
        });

        it('focuses the input field on mount', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: [] })
            });

            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            await waitFor(() => {
                expect(input).toHaveFocus();
            });
        });

        it('disables Clear and Log Event buttons when input is empty', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: [] })
            });

            render(<DescriptionEntry />);

            const clearButton = screen.getByRole('button', { name: /clear/i });
            const logButton = screen.getByRole('button', { name: /log event/i });

            expect(clearButton).toBeDisabled();
            expect(logButton).toBeDisabled();
        });
    });

    describe('Recent Entries Fetching', () => {
        it('fetches recent entries on component mount', async () => {
            const mockEntries = [
                {
                    id: '1',
                    date: '2025-06-22T07:00:00Z',
                    type: 'work',
                    description: '- Fixed bug in authentication',
                    input: 'work - Fixed bug in authentication',
                    original: 'work - Fixed bug in authentication',
                    modifiers: {},
                    creator: {}
                },
                {
                    id: '2',
                    date: '2025-06-22T06:30:00Z',
                    type: 'meal',
                    description: '- Had breakfast',
                    input: 'meal - Had breakfast',
                    original: 'meal - Had breakfast',
                    modifiers: {},
                    creator: {}
                }
            ];

            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: mockEntries })
            });

            render(<DescriptionEntry />);

            await waitFor(() => {
                expect(fetch).toHaveBeenCalledWith('/api/entries?limit=10');
            });

            await waitFor(() => {
                expect(screen.getByText('Recent Events')).toBeInTheDocument();
                expect(screen.getByText('work')).toBeInTheDocument();
                expect(screen.getByText('meal')).toBeInTheDocument();
                expect(screen.getByText('- Fixed bug in authentication')).toBeInTheDocument();
                expect(screen.getByText('- Had breakfast')).toBeInTheDocument();
            });
        });

        it('handles fetch errors gracefully', async () => {
            const consoleSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            fetch.mockRejectedValueOnce(new Error('Network error'));

            render(<DescriptionEntry />);

            await waitFor(() => {
                expect(fetch).toHaveBeenCalledWith('/api/entries?limit=10');
            });

            await waitFor(() => {
                expect(consoleSpy).toHaveBeenCalledWith('Error fetching recent entries:', expect.any(Error));
            });

            consoleSpy.mockRestore();
        });

        it('does not show recent entries section when no entries exist', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: [] })
            });

            render(<DescriptionEntry />);

            await waitFor(() => {
                expect(fetch).toHaveBeenCalledWith('/api/entries?limit=10');
            });

            await waitFor(() => {
                expect(screen.queryByText('Recent Events')).not.toBeInTheDocument();
            });
        });
    });

    describe('Input Handling', () => {
        beforeEach(async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ results: [] })
            });
        });

        it('updates input value when typing', async () => {
            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            
            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });
            
            expect(input.value).toBe('work - Fixed bug');
        });

        it('enables Clear and Log Event buttons when input has content', async () => {
            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            const clearButton = screen.getByRole('button', { name: /clear/i });
            const logButton = screen.getByRole('button', { name: /log event/i });

            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });

            expect(clearButton).toBeEnabled();
            expect(logButton).toBeEnabled();
        });

        it('clears input when Clear button is clicked', async () => {
            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            const clearButton = screen.getByRole('button', { name: /clear/i });

            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });
            fireEvent.click(clearButton);

            expect(input.value).toBe('');
            expect(clearButton).toBeDisabled();
        });

        it('submits form when Enter key is pressed', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ results: [] })
                })
                .mockResolvedValueOnce({
                    status: 201,
                    json: async () => ({
                        success: true,
                        entry: { input: 'work - Fixed bug' }
                    })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ results: [] })
                });

            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');

            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });
            fireEvent.keyUp(input, { key: 'Enter', code: 'Enter' });

            await waitFor(() => {
                expect(fetch).toHaveBeenCalledWith('/api/entries', {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ rawInput: 'work - Fixed bug' })
                });
            });
        });
    });

    describe('Form Submission', () => {
        beforeEach(async () => {
            fetch.mockResolvedValue({
                ok: true,
                json: async () => ({ results: [] })
            });
        });

        it('disables buttons when input contains only whitespace', async () => {
            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            const logButton = screen.getByRole('button', { name: /log event/i });
            const clearButton = screen.getByRole('button', { name: /clear/i });

            fireEvent.change(input, { target: { value: '   ' } });

            // Buttons should be disabled for whitespace-only input
            expect(logButton).toBeDisabled();
            expect(clearButton).toBeDisabled();

            // Toast should not be called since button click won't work
            expect(mockToast).not.toHaveBeenCalled();
        });

        it('shows warning toast when trying to submit with empty description via Enter key', async () => {
            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');

            // Enter key on empty input should show warning
            fireEvent.keyUp(input, { key: 'Enter', code: 'Enter' });

            expect(mockToast).toHaveBeenCalledWith({
                title: 'Empty description',
                description: 'Please enter a description before saving.',
                status: 'warning',
                duration: 3000,
                isClosable: true,
                position: 'top'
            });
        });

        it('successfully submits entry and shows success toast', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ results: [] })
                })
                .mockResolvedValueOnce({
                    status: 201,
                    json: async () => ({
                        success: true,
                        entry: { input: 'work - Fixed bug' }
                    })
                })
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ results: [] })
                });

            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            const logButton = screen.getByRole('button', { name: /log event/i });

            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });
            fireEvent.click(logButton);

            await waitFor(() => {
                expect(mockToast).toHaveBeenCalledWith({
                    title: 'Event logged successfully',
                    description: 'Saved: work - Fixed bug',
                    status: 'success',
                    duration: 4000,
                    isClosable: true,
                    position: 'top'
                });
            });

            expect(input.value).toBe('');
        });

        it('handles API errors and shows error toast', async () => {
            fetch
                .mockResolvedValueOnce({
                    ok: true,
                    json: async () => ({ results: [] })
                })
                .mockResolvedValueOnce({
                    status: 500,
                    statusText: 'Internal Server Error',
                    json: async () => ({ error: 'Database connection failed' })
                });

            render(<DescriptionEntry />);

            const input = screen.getByPlaceholderText('Type your event description here...');
            const logButton = screen.getByRole('button', { name: /log event/i });

            fireEvent.change(input, { target: { value: 'work - Fixed bug' } });
            fireEvent.click(logButton);

            await waitFor(() => {
                expect(mockToast).toHaveBeenCalledWith({
                    title: 'Error logging event',
                    description: 'Database connection failed',
                    status: 'error',
                    duration: 5000,
                    isClosable: true,
                    position: 'top'
                });
            });
        });
    });

    describe('Recent Entries Display', () => {
        it('formats relative time correctly', async () => {
            const now = new Date('2025-06-22T08:00:00Z');
            jest.useFakeTimers();
            jest.setSystemTime(now);

            const mockEntries = [
                {
                    id: '1',
                    date: '2025-06-22T07:59:30Z', // 30 seconds ago
                    type: 'work',
                    description: '- Recent task',
                    input: 'work - Recent task',
                    original: 'work - Recent task',
                    modifiers: {},
                    creator: {}
                },
                {
                    id: '2',
                    date: '2025-06-22T07:30:00Z', // 30 minutes ago
                    type: 'meal',
                    description: '- Had coffee',
                    input: 'meal - Had coffee',
                    original: 'meal - Had coffee',
                    modifiers: {},
                    creator: {}
                }
            ];

            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: mockEntries })
            });

            render(<DescriptionEntry />);

            await waitFor(() => {
                expect(screen.getByText('just now')).toBeInTheDocument();
                expect(screen.getByText('30m ago')).toBeInTheDocument();
            });

            jest.useRealTimers();
        });
    });

    describe('Navigation', () => {
        it('renders Back to Home link correctly', async () => {
            fetch.mockResolvedValueOnce({
                ok: true,
                json: async () => ({ results: [] })
            });

            render(<DescriptionEntry />);

            const backLink = screen.getByRole('link', { name: /back to home/i });
            expect(backLink).toBeInTheDocument();
            expect(backLink).toHaveAttribute('href', '/');
        });
    });
});
