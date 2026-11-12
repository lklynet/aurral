import * as icons from "@untitledui/icons";
import type { ComponentProps } from "react";

export type IconComponent = typeof icons.Play;
type IconProps = ComponentProps<IconComponent>;

function createIcon(Icon: IconComponent): IconComponent {
  return function AppIcon(props: IconProps) {
    return <Icon strokeWidth={1.5} {...props} />;
  };
}

function IconSvg({ size = 24, color = "currentColor", ...props }: IconProps) {
  return (
    <svg
      viewBox="0 0 24 24"
      width={size}
      height={size}
      stroke={color}
      strokeWidth={1.5}
      fill="none"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
      {...props}
    />
  );
}

export const Activity = createIcon(icons.Activity);
export const AlertCircle = createIcon(icons.AlertCircle);
export const AlertTriangle = createIcon(icons.AlertTriangle);
export const ArrowDown = createIcon(icons.ArrowDown);
export const ArrowLeft = createIcon(icons.ArrowLeft);
export const ArrowRight = createIcon(icons.ArrowRight);
export const ArrowUp = createIcon(icons.ArrowUp);
export const ArrowUpCircle = createIcon(icons.ArrowCircleUp);
export const AudioWaveform = createIcon(icons.Waves);
export const Ban = createIcon(icons.SlashCircle01);
export const Bell = createIcon(icons.Bell01);
export const BellRinging = createIcon(icons.BellRinging04);
export const CalendarDays = createIcon(icons.Calendar);
export const Check = createIcon(icons.Check);
export const CheckCircle = createIcon(icons.CheckCircle);
export const CheckCircle2 = createIcon(icons.CheckCircle);
export const ChevronDown = createIcon(icons.ChevronDown);
export const ChevronLeft = createIcon(icons.ChevronLeft);
export const ChevronRight = createIcon(icons.ChevronRight);
export const Circle = createIcon(icons.Circle);
export const ClipboardCopy = createIcon(icons.Clipboard);
export const Clock = createIcon(icons.Clock);
export const Columns3 = createIcon(icons.Columns03);
export const Compass = createIcon(icons.Compass);
export const Copy = createIcon(icons.Copy01);
export const CornerUpLeft = createIcon(icons.CornerUpLeft);
export const Database = createIcon(icons.Database01);
export const Download = createIcon(icons.Download01);
export const Drop = createIcon(icons.Drop);
export const Ellipsis = createIcon(icons.DotsHorizontal);
export const ExternalLink = createIcon(icons.LinkExternal01);
export const Eye = createIcon(icons.Eye);
export const EyeOff = createIcon(icons.EyeOff);
export const FilePlus2 = createIcon(icons.FilePlus01);
export const FileUp = createIcon(icons.Upload01);
export const Fingerprint = createIcon(icons.Fingerprint01);
export const Folder = createIcon(icons.Folder);
export const Grid3X3 = createIcon(icons.Grid01);
export const GripVertical = createIcon(icons.DotsGrid);
export const Headphones = createIcon(icons.Headphones01);
export const Heart = createIcon(icons.Heart);
export const ImagePlus = createIcon(icons.ImagePlus);
export const Inbox = createIcon(icons.Inbox01);
export const Info = createIcon(icons.InfoCircle);
export const LayoutBottom = createIcon(icons.LayoutBottom);
export const LayoutGrid = createIcon(icons.LayoutGrid01);
export const LayoutRight = createIcon(icons.LayoutRight);
export const LayoutTemplate = createIcon(icons.LayoutAlt01);
export const Library = createIcon(icons.BookClosed);
export const Link = createIcon(icons.Link01);
export const List = createIcon(icons.List);
export const ListFilter = createIcon(icons.FilterLines);
export const Locate = createIcon(icons.Target01);
export const LogOut = createIcon(icons.LogOut01);
export const MapPin = createIcon(icons.MarkerPin01);
export const Maximize = createIcon(icons.Maximize01);
export const Menu = createIcon(icons.Menu01);
export const Mic = createIcon(icons.Microphone01);
export const Minus = createIcon(icons.Minus);
export const Minimize = createIcon(icons.Minimize01);
export const Monitor = createIcon(icons.Monitor01);
export const Moon = createIcon(icons.Moon01);
export const MoreHorizontal = createIcon(icons.DotsHorizontal);
export const MoreVertical = createIcon(icons.DotsVertical);
export const Music = createIcon(icons.MusicNote01);
export const Music2 = createIcon(icons.MusicNote02);
export const Newspaper = createIcon(icons.Rss01);
export const Pencil = createIcon(icons.Edit03);
export function Play(props: IconProps) {
  return <icons.Play strokeWidth={1.5} fill="currentColor" {...props} />;
}
export const Puzzle = createIcon(icons.PuzzlePiece01);
export const Plus = createIcon(icons.Plus);
export const RefreshCw = createIcon(icons.RefreshCw01);
export const Repeat = createIcon(icons.Repeat01);
export const RotateCcw = createIcon(icons.RefreshCcw01);
export const Radio = createIcon(icons.Signal01);
export const ScanSearch = createIcon(icons.Scan);
export const Search = createIcon(icons.SearchLg);
export const Settings = createIcon(icons.Settings01);
export const Share = createIcon(icons.Share07);
export const Shuffle = createIcon(icons.Shuffle01);
export const SkipBack = createIcon(icons.SkipBack);
export const SkipForward = createIcon(icons.SkipForward);
export const SlidersHorizontal = createIcon(icons.Sliders04);
export const Sparkles = createIcon(icons.Stars01);
export const Square = createIcon(icons.Square);
export const SquareCheck = createIcon(icons.CheckSquare);
export const Star = createIcon(icons.Star01);
export const Stop = createIcon(icons.Stop);
export const Sun = createIcon(icons.Sun);
export const ThumbsDown = createIcon(icons.ThumbsDown);
export const ThumbsUp = createIcon(icons.ThumbsUp);
export const Ticket = createIcon(icons.Ticket01);
export const Trash2 = createIcon(icons.Trash01);
export const TrendUp = createIcon(icons.TrendUp01);
export const TriangleAlert = createIcon(icons.AlertTriangle);
export const Upload = createIcon(icons.Upload01);
export const User = createIcon(icons.User01);
export const Users = createIcon(icons.Users01);
export const Volume2 = createIcon(icons.VolumeMax);
export const VolumeX = createIcon(icons.VolumeX);
export const Workflow = createIcon(icons.Dataflow01);
export const X = createIcon(icons.XClose);
export const XCircle = createIcon(icons.XCircle);

export function Pause(props: IconProps) {
  return (
    <IconSvg fill="currentColor" {...props}>
      <path d="M7 5h3v14H7zM14 5h3v14h-3z" />
    </IconSvg>
  );
}

export function CircleDot(props: IconProps) {
  return (
    <IconSvg {...props}>
      <circle cx="12" cy="12" r="9" />
      <circle cx="12" cy="12" r="4" fill="currentColor" stroke="none" />
    </IconSvg>
  );
}

export function Repeat1(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="m17 2 4 4m0 0-4 4m4-4H7.8c-1.68 0-2.52 0-3.162.327a3 3 0 0 0-1.311 1.311C3 8.28 3 9.12 3 10.8v.2m0 7h13.2c1.68 0 2.52 0 3.162-.327a3 3 0 0 0 1.311-1.311C21 15.72 21 14.88 21 13.2V13M3 18l4 4m-4-4 4-4" />
      <path d="m10 10 2-1v6m-2 0h4" />
    </IconSvg>
  );
}

export function ListStart(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M4 6h10M4 12h7M4 18h10m2-9 3-3 3 3m-3-3v12" />
    </IconSvg>
  );
}

export function ListEnd(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M4 6h10M4 12h7M4 18h10m2-3 3 3 3-3m-3 3V6" />
    </IconSvg>
  );
}

export function ListMusic(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M3 6h10M3 11h7M3 16h5m10 2V5l4-1v4l-4 1" />
      <ellipse cx="15" cy="18" rx="3" ry="2" />
    </IconSvg>
  );
}

export function ArrowDownAZ(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="m4 17 3 3 3-3M7 20V4M14 10l3-6 3 6m-5-2h4m-5 6h6l-6 6h6" />
    </IconSvg>
  );
}

export function ArrowUpZA(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M4 7 7 4l3 3M7 4v16m7-16h6l-6 6h6m-6 10 3-6 3 6m-5-2h4" />
    </IconSvg>
  );
}

export function GitHub(props: IconProps) {
  return (
    <IconSvg fill="currentColor" stroke="none" {...props}>
      <path d="M12 .5C5.649.5.5 5.649.5 12c0 5.084 3.292 9.398 7.861 10.919.575.106.786-.25.786-.556 0-.274-.01-1-.016-1.962-3.197.695-3.872-1.541-3.872-1.541-.523-1.328-1.277-1.682-1.277-1.682-1.044-.714.079-.699.079-.699 1.154.081 1.761 1.185 1.761 1.185 1.026 1.758 2.692 1.25 3.348.956.104-.743.402-1.251.731-1.539-2.552-.291-5.236-1.276-5.236-5.681 0-1.255.449-2.282 1.184-3.086-.119-.291-.513-1.462.112-3.048 0 0 .966-.309 3.165 1.179A10.98 10.98 0 0 1 12 6.033c.973.004 1.954.132 2.87.388 2.197-1.488 3.162-1.179 3.162-1.179.627 1.586.233 2.757.114 3.048.737.804 1.182 1.831 1.182 3.086 0 4.416-2.688 5.387-5.249 5.673.413.355.781 1.055.781 2.126 0 1.535-.014 2.772-.014 3.149 0 .309.207.668.792.555C20.211 21.394 23.5 17.082 23.5 12 23.5 5.649 18.351.5 12 .5Z" />
    </IconSvg>
  );
}
