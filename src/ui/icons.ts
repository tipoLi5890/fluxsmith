// SPDX-License-Identifier: Apache-2.0
// Single Lucide mapping table (red line 23). Import icons ONLY through this file.
import {
  Search, DraftingCompass, Hammer, Wrench, CircleCheck, Hand, Square, Check, TriangleAlert, Paperclip, Cpu, GitBranch,
  File, History, Coins, Zap, OctagonAlert, RefreshCw, Lock, Brain, MessageSquare, Crosshair, X, Plus, Settings, ChevronDown,
  ChevronRight, ChevronUp, FolderOpen, FilePlus, Info, CircleDot, Layers, ListChecks, Image, Undo2, Play, Sun, Moon, Monitor,
  Keyboard, Copy, Trash2, ScanSearch, Download, Upload, Eye, EyeOff, Grid3x3, ZoomIn, ZoomOut, Maximize, Loader, Sparkles, ShieldAlert,
  Database, Bug, Globe, Link, KeyRound, Puzzle, Bot, ExternalLink, Filter, MoreHorizontal, CircleHelp, Circle, Compass, Package,
  ClipboardList, AlertCircle, FileText, BookOpen, Terminal, Pencil, Save, Ban, Clock, Gauge, CornerLeftUp,
} from "lucide-react";

export const icons = {
  // phases
  thinking: Brain, exploring: Search, designing: DraftingCompass, building: Hammer, fixing: Wrench, reviewing: CircleCheck,
  waiting: Hand, stopping: Square, done: Check, failed: TriangleAlert,
  // domain
  attachment: Paperclip, component: Cpu, net: GitBranch, sheet: File, turn: History, cost: Coins, cache: Zap,
  kicadMissing: OctagonAlert, externalChange: RefreshCw, lock: Lock, status: MessageSquare, focus: Crosshair,
  block: Layers, findings: ListChecks, image: Image, rollback: Undo2, plan: ClipboardList, skill: Puzzle, agent: Bot,
  provider: KeyRound, storage: Database, diagnostics: Bug, web: Globe, link: Link, external: ExternalLink, help: CircleHelp,
  environment: Compass, parts: Package, doc: FileText, reference: BookOpen, developer: Terminal, edit: Pencil, save: Save,
  ban: Ban, clock: Clock, budget: Gauge, sparkles: Sparkles, security: ShieldAlert, parentSheet: CornerLeftUp,
  // chrome
  close: X, add: Plus, settings: Settings, chevronDown: ChevronDown, chevronRight: ChevronRight, chevronUp: ChevronUp,
  open: FolderOpen, newProject: FilePlus, info: Info, badge: CircleDot, circle: Circle, play: Play, light: Sun, dark: Moon,
  system: Monitor, keyboard: Keyboard, copy: Copy, trash: Trash2, download: Download, upload: Upload, show: Eye, hide: EyeOff,
  grid: Grid3x3, zoomIn: ZoomIn, zoomOut: ZoomOut, fit: Maximize, loading: Loader, filter: Filter, more: MoreHorizontal,
  error: AlertCircle, warning: TriangleAlert, search: Search, zoomSelection: ScanSearch,
} as const;

export type IconName = keyof typeof icons;
