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
export const Compass = createIcon(icons.Compass);
export const Copy = createIcon(icons.Copy01);
export const CornerUpLeft = createIcon(icons.CornerUpLeft);
export const Database = createIcon(icons.Database01);
export const DatabaseSearch = createIcon(icons.SearchRefraction);
export const Download = createIcon(icons.Download01);
export const Ellipsis = createIcon(icons.DotsHorizontal);
export const ExternalLink = createIcon(icons.LinkExternal01);
export const Eye = createIcon(icons.Eye);
export const EyeOff = createIcon(icons.EyeOff);
export const FileJson = createIcon(icons.FileCode01);
export const FilePlus2 = createIcon(icons.FilePlus01);
export const FileUp = createIcon(icons.Upload01);
export const Fingerprint = createIcon(icons.Fingerprint01);
export const Folder = createIcon(icons.Folder);
export const FolderCog = createIcon(icons.FolderCode);
export const FolderInput = createIcon(icons.FolderDownload);
export const FolderPlus = createIcon(icons.FolderPlus);
export const Grid3X3 = createIcon(icons.Grid01);
export const GripVertical = createIcon(icons.DotsGrid);
export const HardDrive = createIcon(icons.HardDrive);
export const Headphones = createIcon(icons.Headphones01);
export const Heart = createIcon(icons.Heart);
export const ImagePlus = createIcon(icons.ImagePlus);
export const Inbox = createIcon(icons.Inbox01);
export const Info = createIcon(icons.InfoCircle);
export const LayoutGrid = createIcon(icons.LayoutGrid01);
export const LayoutTemplate = createIcon(icons.LayoutAlt01);
export const Library = createIcon(icons.BookClosed);
export const Link = createIcon(icons.Link01);
export const List = createIcon(icons.List);
export const ListChecks = createIcon(icons.ClipboardCheck);
export const ListFilter = createIcon(icons.FilterLines);
export const Locate = createIcon(icons.Target01);
export const Lock = createIcon(icons.Lock01);
export const LockOpen = createIcon(icons.LockUnlocked01);
export const LogOut = createIcon(icons.LogOut01);
export const MapPin = createIcon(icons.MarkerPin01);
export const Menu = createIcon(icons.Menu01);
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
export const Plus = createIcon(icons.Plus);
export const RefreshCw = createIcon(icons.RefreshCw01);
export const Repeat = createIcon(icons.Repeat01);
export const RotateCcw = createIcon(icons.RefreshCcw01);
export const Rss = createIcon(icons.Rss01);
export const Save = createIcon(icons.Save01);
export const ScanSearch = createIcon(icons.Scan);
export const Search = createIcon(icons.SearchLg);
export const Server = createIcon(icons.Server01);
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
export const Sun = createIcon(icons.Sun);
export const ThumbsDown = createIcon(icons.ThumbsDown);
export const ThumbsUp = createIcon(icons.ThumbsUp);
export const Ticket = createIcon(icons.Ticket01);
export const Trash2 = createIcon(icons.Trash01);
export const TrendUp = createIcon(icons.TrendUp01);
export const TriangleAlert = createIcon(icons.AlertTriangle);
export const Upload = createIcon(icons.Upload01);
export const User = createIcon(icons.User01);
export const UserPlus = createIcon(icons.UserPlus01);
export const Users = createIcon(icons.Users01);
export const Volume2 = createIcon(icons.VolumeMax);
export const VolumeX = createIcon(icons.VolumeX);
export const Workflow = createIcon(icons.Dataflow01);
export const Wrench = createIcon(icons.Tool01);
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

export function FolderSync(props: IconProps) {
  return (
    <IconSvg {...props}>
      <path d="M3 7V5a2 2 0 0 1 2-2h4l2 4h8a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V7Z" />
      <path d="m10 14 2-2h4m-6 2v-2m8 4-2 2h-4m6-2v2" />
    </IconSvg>
  );
}
