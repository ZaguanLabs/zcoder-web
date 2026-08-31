type IconProps = { name: "bolt" | "plus" | "logout" | "send" | "stop" | "server" | "chevron"; size?: number };

const paths = {
  bolt: <path d="M13 2 4.5 13h6L9 22l8.5-12h-6L13 2Z" />,
  plus: <path d="M12 5v14M5 12h14" />,
  logout: <path d="M10 17l5-5-5-5M15 12H3M14 3h5a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-5" />,
  send: <path d="m22 2-7 20-4-9-9-4 20-7ZM11 13 22 2" />,
  stop: <path d="M7 7h10v10H7z" />,
  server: <><rect x="3" y="4" width="18" height="6" rx="1" /><rect x="3" y="14" width="18" height="6" rx="1" /><path d="M7 7h.01M7 17h.01" /></>,
  chevron: <path d="m9 18 6-6-6-6" />,
};

export function Icon({ name, size = 16 }: IconProps) {
  return <svg aria-hidden="true" width={size} height={size} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="square" strokeLinejoin="miter">{paths[name]}</svg>;
}

