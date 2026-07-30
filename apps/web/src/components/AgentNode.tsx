import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useTranslation } from 'react-i18next';
import { Activity, ArrowUpRight, BadgeCheck, Database, Globe, ListChecks, MessageSquare, Minimize2, Network, Plug, Repeat2, Route, Scan, ShieldCheck, Sparkles } from 'lucide-react';
import type { AgentNode as AgentNodeType } from '../types';
import { catalog } from '../data/catalog';

const icons = { message: MessageSquare, sparkles: Sparkles, repeat: Repeat2, 'list-checks': ListChecks, route: Route, network: Network, database: Database, globe: Globe, plug: Plug, 'shield-check': ShieldCheck, scan: Scan, activity: Activity, 'minimize-2': Minimize2, 'badge-check': BadgeCheck, 'arrow-up-right': ArrowUpRight } as const;

export function AgentNode({ data, selected }: NodeProps<AgentNodeType>) {
  const { t } = useTranslation();
  const Icon = icons[data.icon as keyof typeof icons] ?? Sparkles;
  const manifest = catalog.find((item) => item.id === data.manifestId);
  const label = manifest && data.label === manifest.name ? t(manifest.name) : data.label;
  const description = manifest && data.description === manifest.description ? t(manifest.description) : data.description;
  return <div className={`agent-node ${selected ? 'is-selected' : ''} status-${data.status ?? 'idle'}`} style={{ '--node-accent': data.color } as React.CSSProperties}>
    <Handle type="target" position={Position.Left} className="flow-handle" />
    <div className="node-accent" />
    <div className="node-main">
      <div className="node-icon"><Icon size={15} strokeWidth={1.8} /></div>
      <div className="node-copy"><div className="node-title">{label}</div><div className="node-kind">{data.manifestId}</div></div>
      {data.isOverride && <span className="override-dot" title={t('INSTANCE OVERRIDE')} />}
    </div>
    <div className="node-description">{description}</div>
    <Handle type="source" position={Position.Right} className="flow-handle" />
  </div>;
}
