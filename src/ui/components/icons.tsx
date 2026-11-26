export const IconPen = () => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="currentColor" aria-hidden="true">
        <path d="M12.146.146a.5.5 0 0 1 .708 0l3 3a.5.5 0 0 1 0 .708l-10 10a.5.5 0 0 1-.168.11l-5 2a.5.5 0 0 1-.65-.65l2-5a.5.5 0 0 1 .11-.168l10-10zM11.207 2.5 13.5 4.793 14.793 3.5 12.5 1.207 11.207 2.5zm1.586 3L10.5 3.207 4 9.707V10h.5a.5.5 0 0 1 .5.5v.5h.5a.5.5 0 0 1 .5.5v.5h.293l6.5-6.5zm-9.761 5.175-.106.106-1.528 3.821 3.821-1.528.106-.106A.5.5 0 0 1 5 12.5V12h-.5a.5.5 0 0 1-.5-.5V11h-.5a.5.5 0 0 1-.468-.325z" />
    </svg>
);

/** A bell; `off`: crossed out (muted). */
export const IconBell = ({ off }: { off?: boolean }) => (
    <svg viewBox="0 0 16 16" width="12" height="12" fill="none" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M4 11V7a4 4 0 0 1 8 0v4l1.5 1.5h-11z" />
        <path d="M6.5 14a1.5 1.5 0 0 0 3 0" />
        {off && <path d="M2 2l12 12" />}
    </svg>
);
