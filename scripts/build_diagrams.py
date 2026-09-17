#!/usr/bin/env python3
"""Build Rex Harness guide diagrams as semantic, offline SVG files."""

from __future__ import annotations

from dataclasses import dataclass, field
from html import escape
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
ASSETS = ROOT / "assets"

COLORS = {
    "background": "#ffffff",
    "text": "#111827",
    "muted": "#6b7280",
    "border": "#d1d5db",
    "section": "#dbe5f1",
    "purple": "#7c3aed",
    "purple_fill": "#faf5ff",
    "blue": "#2563eb",
    "blue_fill": "#eff6ff",
    "green": "#16a34a",
    "green_fill": "#f0fdf4",
    "orange": "#ea580c",
    "orange_fill": "#fff7ed",
    "red": "#dc2626",
    "red_fill": "#fef2f2",
    "gray": "#64748b",
    "gray_fill": "#f8fafc",
}

FONT = (
    "'Helvetica Neue', Helvetica, Arial, 'PingFang SC', 'Microsoft YaHei', "
    "'Microsoft JhengHei', 'SimHei', sans-serif"
)


@dataclass
class Diagram:
    width: int
    height: int
    title: str
    subtitle: str
    diagram_type: str
    description: str
    containers: list[str] = field(default_factory=list)
    edges: list[str] = field(default_factory=list)
    nodes: list[str] = field(default_factory=list)
    labels: list[str] = field(default_factory=list)
    overlays: list[str] = field(default_factory=list)

    def render(self) -> str:
        lines: list[str] = []
        lines.append(
            f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {self.width} {self.height}" '
            f'width="{self.width}" height="{self.height}" role="img" '
            f'aria-labelledby="diagram-title diagram-desc" data-generator="fireworks-tech-graph" '
            f'data-schema-version="1" data-style-id="1" data-visual-theme="Flat Icon" '
            f'data-diagram-type="{escape(self.diagram_type)}" data-quality-profile="showcase" '
            'data-max-bends-per-edge="2" data-max-total-bends="32" '
            'data-max-route-stretch="4" data-max-bridged-crossings="0" '
            'data-min-node-gap="40" data-min-container-gutter="20" '
            'data-min-label-clearance="4" data-min-segment-length="16">'
        )
        lines.append(f'  <title id="diagram-title">{escape(self.title)}</title>')
        lines.append(f'  <desc id="diagram-desc">{escape(self.description)}</desc>')
        lines.append('  <defs>')
        for name in ("purple", "blue", "green", "orange", "red", "gray"):
            color = COLORS[name]
            lines.append(
                f'    <marker id="arrow-{name}" markerWidth="10" markerHeight="7" '
                'refX="9" refY="3.5" orient="auto">'
            )
            lines.append(f'      <polygon points="0 0, 10 3.5, 0 7" fill="{color}"/>')
            lines.append('    </marker>')
        lines.append('    <style>')
        lines.append(f'      text {{ font-family: {FONT}; }}')
        lines.append('      .title { font-size: 30px; font-weight: 700; fill: #111827; }')
        lines.append('      .subtitle { font-size: 14px; font-weight: 500; fill: #6b7280; }')
        lines.append('      .section { font-size: 13px; font-weight: 700; fill: #2563eb; letter-spacing: 1.2px; }')
        lines.append('      .node-title { font-size: 16px; font-weight: 700; fill: #111827; }')
        lines.append('      .node-sub { font-size: 12px; font-weight: 500; fill: #6b7280; }')
        lines.append('      .node-type { font-size: 10px; font-weight: 700; fill: #94a3b8; letter-spacing: 1px; }')
        lines.append('      .edge-label { font-size: 12px; font-weight: 600; fill: #4b5563; }')
        lines.append('      .legend { font-size: 12px; font-weight: 500; fill: #6b7280; }')
        lines.append('      .footer { font-size: 11px; font-weight: 500; fill: #94a3b8; }')
        lines.append('    </style>')
        lines.append('  </defs>')
        lines.append(
            f'  <rect data-graph-role="background" width="{self.width}" height="{self.height}" '
            f'fill="{COLORS["background"]}"/>'
        )
        lines.append(
            f'  <g data-graph-role="reserved" data-reserved-kind="title" '
            f'data-graph-bounds="30,20,{self.width - 30},92">'
        )
        lines.append(f'    <text x="{self.width / 2}" y="52" text-anchor="middle" class="title">{escape(self.title)}</text>')
        lines.append(f'    <text x="{self.width / 2}" y="78" text-anchor="middle" class="subtitle">{escape(self.subtitle)}</text>')
        lines.append('  </g>')
        lines.extend(self.containers)
        lines.extend(self.edges)
        lines.extend(self.nodes)
        lines.extend(self.labels)
        lines.extend(self.overlays)
        lines.append('</svg>')
        return "\n".join(lines) + "\n"


def container(node_id: str, x: int, y: int, width: int, height: int, label: str) -> str:
    return "\n".join([
        f'  <g id="container-{escape(node_id)}" data-graph-role="container" '
        f'data-container-id="{escape(node_id)}" data-graph-bounds="{x},{y},{x + width},{y + height}">',
        f'    <rect x="{x}" y="{y}" width="{width}" height="{height}" rx="16" '
        f'fill="none" stroke="{COLORS["section"]}" stroke-width="1.4" stroke-dasharray="6 5"/>',
        f'    <text x="{x + 18}" y="{y + 25}" class="section">{escape(label.upper())}</text>',
        f'    <rect data-graph-role="reserved" data-reserved-kind="container-header" '
        f'x="{x + 8}" y="{y + 6}" width="220" height="30" fill="none" stroke="none"/>',
        '  </g>',
    ])


def node(
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    subtitle: str = "",
    *,
    color: str = "blue",
    kind: str = "rect",
    type_label: str = "",
    title_size: int = 16,
) -> str:
    stroke = COLORS[color]
    fill = COLORS[f"{color}_fill"] if f"{color}_fill" in COLORS else COLORS["gray_fill"]
    cx = x + width / 2
    lines = [
        f'  <g id="node-{escape(node_id)}" data-graph-role="node" data-node-id="{escape(node_id)}" '
        f'data-semantic-role="{escape(kind)}" data-graph-bounds="{x},{y},{x + width},{y + height}">'
    ]
    if kind == "double_rect":
        lines.append(
            f'    <rect x="{x}" y="{y}" width="{width}" height="{height}" rx="10" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="2"/>'
        )
        lines.append(
            f'    <rect x="{x + 6}" y="{y + 6}" width="{width - 12}" height="{height - 12}" rx="7" '
            f'fill="none" stroke="{stroke}" stroke-width="1.1" opacity="0.62"/>'
        )
    elif kind == "document":
        lines.append(
            f'    <path d="M {x},{y} L {x + width - 14},{y} L {x + width},{y + 14} '
            f'L {x + width},{y + height} L {x},{y + height} Z" fill="{fill}" '
            f'stroke="{stroke}" stroke-width="1.8"/>'
        )
        lines.append(
            f'    <path d="M {x + width - 14},{y} L {x + width - 14},{y + 14} '
            f'L {x + width},{y + 14}" fill="none" stroke="{stroke}" stroke-width="1.2"/>'
        )
    else:
        lines.append(
            f'    <rect x="{x}" y="{y}" width="{width}" height="{height}" rx="10" '
            f'fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>'
        )
    if type_label:
        lines.append(f'    <text x="{cx}" y="{y + 18}" text-anchor="middle" class="node-type">{escape(type_label)}</text>')
    title_y = y + (height / 2) - (7 if subtitle else -5) + (7 if type_label else 0)
    lines.append(
        f'    <text x="{cx}" y="{title_y}" text-anchor="middle" class="node-title" '
        f'font-size="{title_size}">{escape(title)}</text>'
    )
    if subtitle:
        lines.append(f'    <text x="{cx}" y="{title_y + 22}" text-anchor="middle" class="node-sub">{escape(subtitle)}</text>')
    lines.append('  </g>')
    return "\n".join(lines)


def cylinder(
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    subtitle: str,
    *,
    color: str = "green",
) -> str:
    stroke = COLORS[color]
    fill = COLORS[f"{color}_fill"]
    cx = x + width / 2
    cap = 10
    return "\n".join([
        f'  <g id="node-{escape(node_id)}" data-graph-role="node" data-node-id="{escape(node_id)}" '
        f'data-semantic-role="cylinder" data-graph-bounds="{x},{y},{x + width},{y + height}">',
        f'    <rect x="{x}" y="{y + cap}" width="{width}" height="{height - 2 * cap}" fill="{fill}" stroke="none"/>',
        f'    <line x1="{x}" y1="{y + cap}" x2="{x}" y2="{y + height - cap}" stroke="{stroke}" stroke-width="1.8"/>',
        f'    <line x1="{x + width}" y1="{y + cap}" x2="{x + width}" y2="{y + height - cap}" stroke="{stroke}" stroke-width="1.8"/>',
        f'    <ellipse cx="{cx}" cy="{y + cap}" rx="{width / 2}" ry="{cap}" fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>',
        f'    <ellipse cx="{cx}" cy="{y + height - cap}" rx="{width / 2}" ry="{cap}" fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>',
        f'    <text x="{cx}" y="{y + height / 2 - 2}" text-anchor="middle" class="node-title">{escape(title)}</text>',
        f'    <text x="{cx}" y="{y + height / 2 + 18}" text-anchor="middle" class="node-sub">{escape(subtitle)}</text>',
        '  </g>',
    ])


def diamond(
    node_id: str,
    x: int,
    y: int,
    width: int,
    height: int,
    title: str,
    subtitle: str = "",
    *,
    color: str = "orange",
) -> str:
    stroke = COLORS[color]
    fill = COLORS[f"{color}_fill"]
    cx = x + width / 2
    cy = y + height / 2
    points = f"{cx},{y} {x + width},{cy} {cx},{y + height} {x},{cy}"
    lines = [
        f'  <g id="node-{escape(node_id)}" data-graph-role="node" data-node-id="{escape(node_id)}" '
        f'data-semantic-role="decision" data-graph-bounds="{x},{y},{x + width},{y + height}">',
        f'    <polygon points="{points}" fill="{fill}" stroke="{stroke}" stroke-width="1.8"/>',
        f'    <text x="{cx}" y="{cy - (4 if subtitle else -5)}" text-anchor="middle" class="node-title" font-size="14">{escape(title)}</text>',
    ]
    if subtitle:
        lines.append(f'    <text x="{cx}" y="{cy + 17}" text-anchor="middle" class="node-sub">{escape(subtitle)}</text>')
    lines.append('  </g>')
    return "\n".join(lines)


def edge(
    edge_id: str,
    source: str,
    target: str,
    points: list[tuple[int, int]],
    *,
    color: str = "purple",
    dashed: bool = False,
) -> str:
    if len(points) < 2:
        raise ValueError(f"edge {edge_id} requires at least two points")
    path = "M " + " L ".join(f"{x},{y}" for x, y in points)
    bends = max(0, len(points) - 2)
    dash = ' stroke-dasharray="6,4"' if dashed else ""
    return (
        f'  <path id="edge-{escape(edge_id)}" data-graph-role="edge" '
        f'data-edge-id="{escape(edge_id)}" data-source="{escape(source)}" '
        f'data-target="{escape(target)}" data-flow="{escape(color)}" '
        f'data-bends="{bends}" data-bridges="" d="{path}" fill="none" '
        f'stroke="{COLORS[color]}" stroke-width="2.2" stroke-linecap="round" '
        f'stroke-linejoin="round" marker-end="url(#arrow-{color})"{dash}/>'
    )


def edge_label(owner: str, text: str, x: int, y: int, width: int) -> str:
    left = x - width / 2
    top = y - 15
    return "\n".join([
        f'  <g id="label-{escape(owner)}" data-graph-role="label" data-owner="{escape(owner)}" '
        f'data-graph-bounds="{left},{top},{left + width},{top + 22}">',
        f'    <rect x="{left}" y="{top}" width="{width}" height="22" rx="6" fill="#ffffff" opacity="0.96"/>',
        f'    <text x="{x}" y="{y}" text-anchor="middle" class="edge-label">{escape(text)}</text>',
        '  </g>',
    ])


def legend(y: int, items: list[tuple[str, str]], *, footer: str, width: int = 1200) -> str:
    lines = [
        f'  <g data-graph-role="legend" data-graph-bounds="40,{y - 18},{width - 40},{y + 20}">'
    ]
    x = 50
    for color, label in items:
        lines.append(
            f'    <line data-graph-role="decoration" x1="{x}" y1="{y}" x2="{x + 30}" y2="{y}" '
            f'stroke="{COLORS[color]}" stroke-width="2.2" marker-end="url(#arrow-{color})"/>'
        )
        lines.append(f'    <text data-graph-role="decoration" x="{x + 40}" y="{y + 4}" class="legend">{escape(label)}</text>')
        x += 40 + max(80, len(label) * 13)
    lines.append('  </g>')
    lines.append(
        f'  <g data-graph-role="reserved" data-reserved-kind="footer" '
        f'data-graph-bounds="40,{y + 20},{width - 40},{y + 50}">'
    )
    lines.append(f'    <text x="{width - 50}" y="{y + 37}" text-anchor="end" class="footer">{escape(footer)}</text>')
    lines.append('  </g>')
    return "\n".join(lines)


def architecture_diagram() -> Diagram:
    diagram = Diagram(
        1200,
        980,
        "Rex Harness 在 AI 开发中的位置",
        "Rex 控制流程；Coding Agent 执行；AIOS 提供可选宿主能力",
        "architecture",
        "Rex Harness 独立模式与 AIOS 集成模式架构。",
    )
    diagram.containers.extend([
        container("hosts", 40, 110, 1120, 150, "Execution Hosts"),
        container("rex", 40, 300, 1120, 210, "Rex Control Plane"),
        container("capabilities", 40, 550, 1120, 160, "Capability Modules"),
        container("platform", 40, 750, 1120, 140, "State and Integration"),
    ])
    diagram.edges.extend([
        edge("standalone-call", "standalone-agent", "workflow-core", [(280, 236), (280, 350)], color="purple"),
        edge("aios-call", "aios-host", "workflow-core", [(920, 236), (920, 350)], color="purple"),
        edge("select-discovery", "workflow-core", "discovery", [(280, 460), (280, 600)], color="orange"),
        edge("select-planning", "workflow-core", "planning", [(450, 460), (450, 600)], color="orange"),
        edge("select-delivery", "workflow-core", "delivery", [(765, 460), (765, 600)], color="orange"),
        edge("select-review", "workflow-core", "review", [(1035, 460), (1035, 600)], color="orange"),
        edge("provider-command", "workflow-core", "providers", [(600, 460), (600, 780)], color="purple"),
        edge("standalone-state", "discovery", "standalone-store", [(280, 676), (280, 790)], color="green", dashed=True),
        edge("aios-services", "aios-host", "host-services", [(1060, 198), (1170, 198), (1170, 815), (1130, 815)], color="blue", dashed=True),
    ])
    diagram.nodes.extend([
        node("standalone-agent", 140, 160, 280, 76, "Standalone Coding Agent", "Codex · Claude · Gemini · OpenCode", color="blue", kind="double_rect", type_label="MODE A"),
        node("aios-host", 780, 160, 280, 76, "AIOS Host", "runner · ContextDB · Team · recovery", color="purple", kind="double_rect", type_label="MODE B"),
        node("workflow-core", 70, 350, 1060, 110, "Adaptive Software Workflow Core", "Observation · Fact · one Capability · Activation · Command · Evidence", color="purple", kind="double_rect", type_label="ONLY CONTROL AUTHORITY", title_size=19),
        node("discovery", 70, 600, 220, 76, "Discovery", "requirements · design · wayfinding", color="blue", type_label="CAPABILITY GROUP"),
        node("planning", 340, 600, 220, 76, "Planning", "dependency graph · frontier", color="orange", type_label="CAPABILITY GROUP"),
        node("delivery", 640, 600, 250, 76, "Delivery", "test design · TDD · debug · implement", color="green", type_label="CAPABILITY GROUP", title_size=15),
        node("review", 940, 600, 190, 76, "Review", "standards/spec · specialist", color="red", type_label="ASSURANCE"),
        cylinder("standalone-store", 70, 790, 220, 60, ".rex-harness", "workflow · journal · receipts", color="green"),
        node("providers", 490, 780, 220, 70, "Provider Skills", "execute current Command only", color="purple", kind="document", type_label="EXECUTION INSTRUCTIONS"),
        node("host-services", 900, 780, 230, 70, "AIOS Services", "model runner · memory · team", color="blue", type_label="OPTIONAL HOST"),
    ])
    diagram.labels.extend([
        edge_label("standalone-call", "CLI start / evidence", 360, 292, 142),
        edge_label("aios-call", "JS API", 960, 292, 78),
        edge_label("provider-command", "current Command", 680, 735, 122),
        edge_label("standalone-state", "persist", 225, 735, 70),
        edge_label("aios-services", "host runtime", 1100, 530, 104),
    ])
    diagram.overlays.append(legend(
        920,
        [("purple", "control / command"), ("orange", "capability selection"), ("green", "evidence / state"), ("blue", "host service")],
        footer="Style 1 · Flat Icon · Rex Harness architecture",
    ))
    return diagram


def control_loop_diagram() -> Diagram:
    diagram = Diagram(
        1200,
        760,
        "单 Command 证据控制循环",
        "每轮只执行一个 Provider Command；Evidence 合格后才能换 Stage 或 Capability",
        "flowchart",
        "Rex Harness 从请求到证据验证、完成或留在当前阶段的控制循环。",
    )
    diagram.containers.append(container("loop", 40, 110, 1120, 530, "Evidence-Gated Control Loop"))
    diagram.edges.extend([
        edge("request-facts", "request", "facts", [(220, 195), (270, 195)], color="purple"),
        edge("facts-select", "facts", "selector", [(430, 195), (480, 195)], color="purple"),
        edge("select-command", "selector", "command", [(660, 195), (720, 195)], color="purple"),
        edge("command-agent", "command", "agent", [(900, 195), (960, 195)], color="purple"),
        edge("agent-evidence", "agent", "evidence", [(1050, 230), (1050, 380)], color="green"),
        edge("evidence-gate", "evidence", "gate", [(960, 415), (900, 415)], color="green"),
        edge("gate-state", "gate", "state", [(720, 415), (660, 415)], color="blue"),
        edge("state-outcome", "state", "outcome", [(480, 415), (430, 415)], color="blue"),
        edge("outcome-complete", "outcome", "completed", [(270, 415), (220, 415)], color="blue"),
        edge("outcome-next", "outcome", "facts", [(350, 360), (350, 230)], color="orange"),
        edge("gate-stay", "gate", "stay", [(810, 470), (810, 540)], color="red"),
    ])
    diagram.nodes.extend([
        node("request", 60, 160, 160, 70, "Request", "task · intent · signals", color="gray", type_label="INPUT"),
        node("facts", 270, 160, 160, 70, "Facts", "evidence-backed", color="blue", type_label="NORMALIZE"),
        node("selector", 480, 160, 180, 70, "Capability Selector", "highest eligible priority", color="orange", type_label="DECIDE", title_size=14),
        node("command", 720, 160, 180, 70, "Current Command", "one provider · one stage", color="purple", type_label="CONTROL"),
        node("agent", 960, 160, 180, 70, "Coding Agent", "current objective only", color="purple", kind="double_rect", type_label="EXECUTE"),
        node("evidence", 960, 380, 180, 70, "Typed Evidence", "artifact · diff · receipt", color="green", type_label="RETURN"),
        diamond("gate", 720, 360, 180, 110, "Evidence 匹配？", "kind · ref · token", color="green"),
        node("state", 480, 380, 180, 70, "Activation State", "advance Stage · rotate token", color="blue", type_label="PERSIST"),
        diamond("outcome", 270, 360, 160, 110, "仍有下一步？", "re-evaluate Facts", color="orange"),
        node("completed", 60, 380, 160, 70, "Completed", "no eligible Capability", color="green", type_label="TERMINAL"),
        node("stay", 720, 540, 180, 70, "Same Stage / Blocked", "补齐真实 Evidence", color="red", type_label="FAIL CLOSED", title_size=14),
    ])
    diagram.labels.extend([
        edge_label("select-command", "one", 690, 177, 52),
        edge_label("agent-evidence", "result", 1092, 307, 62),
        edge_label("outcome-complete", "no", 245, 395, 42),
        edge_label("outcome-next", "yes · next Capability", 430, 298, 156),
        edge_label("gate-stay", "invalid / missing", 900, 512, 128),
    ])
    diagram.overlays.append(legend(
        690,
        [("purple", "command flow"), ("green", "evidence"), ("blue", "state transition"), ("orange", "feedback"), ("red", "fail closed")],
        footer="Style 1 · Flat Icon · evidence-gated loop",
    ))
    return diagram


def tdd_diagram() -> Diagram:
    diagram = Diagram(
        1200,
        930,
        "核心 TDD Workflow",
        "先确认测试范围与诚实 RED；再选择 TDD、Strict TDD、Hardening 或 Replan",
        "flowchart",
        "Rex Harness 测试设计、可测试性判断、风险分级 TDD 与审查流程。",
    )
    diagram.containers.extend([
        container("scope", 40, 100, 1120, 180, "Scope and Testability"),
        container("delivery", 40, 310, 1120, 390, "Delivery Branches"),
        container("assurance", 40, 720, 1120, 130, "Assurance"),
    ])
    diagram.edges.extend([
        edge("behavior-design", "behavior", "test-design", [(220, 200), (280, 200)], color="purple"),
        edge("design-decision", "test-design", "testability", [(490, 200), (560, 200)], color="purple"),
        edge("decision-risk", "testability", "risk", [(680, 260), (680, 295), (620, 295), (620, 350)], color="orange"),
        edge("decision-hardening", "testability", "hardening", [(610, 260), (610, 350), (175, 350), (175, 370)], color="blue"),
        edge("decision-blocked", "testability", "blocked", [(800, 200), (1060, 200), (1060, 370)], color="red"),
        edge("risk-tdd", "risk", "tdd", [(500, 410), (455, 410), (455, 550)], color="orange"),
        edge("risk-strict", "risk", "strict-tdd", [(740, 410), (820, 410), (820, 550)], color="red"),
        edge("hardening-review", "hardening", "hardening-review", [(280, 470), (280, 760)], color="green"),
        edge("tdd-review", "tdd", "tdd-review", [(455, 660), (455, 760)], color="green"),
        edge("strict-review", "strict-tdd", "strict-review", [(820, 660), (820, 760)], color="green"),
        edge("blocked-replan", "blocked", "replan", [(1060, 460), (1060, 550)], color="red"),
    ])
    diagram.nodes.extend([
        node("behavior", 60, 165, 160, 70, "Behavior Change", "new observable outcome", color="gray", type_label="TRIGGER", title_size=14),
        node("test-design", 280, 155, 210, 90, "Test Design", "scope · acceptance · public seam", color="blue", type_label="MANDATORY GATE"),
        diamond("testability", 560, 140, 240, 120, "Testability Decision", "receipt-backed", color="orange"),
        node("hardening", 60, 370, 230, 100, "Hardening", "baseline · harden · verify invariants", color="blue", type_label="ZERO-EXIT BASELINE", title_size=15),
        diamond("risk", 500, 350, 240, 120, "Elevated Risk?", "external · system · irreversible", color="orange"),
        node("blocked", 980, 370, 160, 90, "Blocked", "acceptance not observable", color="red", type_label="NO HONEST TEST"),
        node("tdd", 350, 550, 210, 110, "TDD", "RED · GREEN · REFACTOR", color="green", kind="double_rect", type_label="ORDINARY RISK"),
        node("strict-tdd", 700, 550, 240, 110, "Strict TDD", "RED · GREEN · REFACTOR · probe", color="red", kind="double_rect", type_label="ELEVATED RISK", title_size=17),
        node("replan", 980, 550, 160, 90, "Replan Gate", "current workflow stops", color="red", type_label="TERMINAL", title_size=14),
        node("hardening-review", 60, 760, 230, 70, "Review · Completed", "invariants · standards/spec", color="green", type_label="DIFF READY"),
        node("tdd-review", 350, 760, 210, 70, "Review · Completed", "test diff · standards/spec", color="green", type_label="DIFF READY"),
        node("strict-review", 700, 760, 240, 70, "Review · Completed", "specialist optional · standards/spec", color="green", type_label="DIFF READY"),
    ])
    diagram.labels.extend([
        edge_label("behavior-design", "must", 250, 182, 52),
        edge_label("decision-risk", "behavior-delta", 748, 306, 112),
        edge_label("decision-hardening", "behavior preserving", 420, 275, 146),
        edge_label("decision-blocked", "blocked", 930, 182, 70),
        edge_label("risk-tdd", "ordinary", 455, 510, 74),
        edge_label("risk-strict", "elevated", 820, 510, 76),
        edge_label("hardening-review", "zero-exit baseline", 250, 615, 132),
        edge_label("tdd-review", "diff ready", 510, 711, 84),
        edge_label("strict-review", "diff ready", 875, 711, 84),
        edge_label("blocked-replan", "stop", 1105, 505, 48),
    ])
    diagram.overlays.append(legend(
        880,
        [("purple", "mandatory gate"), ("orange", "decision"), ("blue", "hardening"), ("red", "high risk / blocked"), ("green", "verified delivery")],
        footer="Style 1 · Flat Icon · Rex Harness TDD workflow",
    ))
    return diagram


def write_diagram(filename: str, diagram: Diagram) -> None:
    target = ASSETS / filename
    target.write_text(diagram.render(), encoding="utf-8")
    print(target)


def main() -> None:
    ASSETS.mkdir(parents=True, exist_ok=True)
    write_diagram("rex-harness-architecture.svg", architecture_diagram())
    write_diagram("rex-harness-control-loop.svg", control_loop_diagram())
    write_diagram("rex-harness-tdd-workflow.svg", tdd_diagram())


if __name__ == "__main__":
    main()
