import { useState } from "react";
import "./MarkerToolbar.css";

/*
 * The three marker colors the panel offers, as buttons. "green" keeps
 * AirCanvas's existing default value ("#00ff66") so a user who never
 * touches this toolbar still draws in the original color.
 */
const COLOR_OPTIONS = [
    { name: "green", value: "#00ff66" },
    { name: "blue", value: "#2f8fff" },
    { name: "red", value: "#ff3b30" },
];

const MIN_WIDTH = 2;
const MAX_WIDTH = 24;

/*
 * Lives entirely outside AirCanvas.jsx. It only produces two values —
 * color and width — in the exact shape AirCanvas already expects via
 * its `markerColor` / `markerWidth` props, so nothing about AirCanvas
 * itself needs to change.
 */
export function useMarkerSettings(
    initialColor = COLOR_OPTIONS[0].value,
    initialWidth = 4
) {
    const [markerColor, setMarkerColor] = useState(initialColor);
    const [markerWidth, setMarkerWidth] = useState(initialWidth);

    return {
        markerColor,
        markerWidth,
        setMarkerColor,
        setMarkerWidth,
    };
}

/*
 * Floating toolbar meant to sit on top of the local controller's own
 * video tile (the one instance of AirCanvas with isController=true).
 * Render it only there — every other tile just replays events that
 * already carry their own color/width, so it has nothing to control.
 */
export default function MarkerToolbar({
    color,
    width,
    onColorChange,
    onWidthChange,
    visible = true,
}) {
    if (!visible) {
        return null;
    }

    return (
        <div className="marker-toolbar" role="toolbar" aria-label="Marker settings">
            <div className="marker-toolbar__colors">
                {COLOR_OPTIONS.map((option) => (
                    <button
                        key={option.name}
                        type="button"
                        className={
                            "marker-toolbar__color-btn" +
                            (option.value.toLowerCase() === color.toLowerCase()
                                ? " marker-toolbar__color-btn--active"
                                : "")
                        }
                        style={{ "--btn-color": option.value }}
                        aria-label={`Use ${option.name} marker`}
                        aria-pressed={option.value.toLowerCase() === color.toLowerCase()}
                        onClick={() => onColorChange(option.value)}
                    >
                        <span className="marker-toolbar__color-swatch" />
                        {option.name}
                    </button>
                ))}
            </div>

            <div className="marker-toolbar__divider" />

            <div className="marker-toolbar__size">
                <span className="marker-toolbar__size-label">Size</span>

                <input
                    type="range"
                    className="marker-toolbar__size-track"
                    min={MIN_WIDTH}
                    max={MAX_WIDTH}
                    step={1}
                    value={width}
                    onChange={(event) =>
                        onWidthChange(Number(event.target.value))
                    }
                    aria-label="Marker size"
                />

                <div className="marker-toolbar__preview">
                    <span
                        className="marker-toolbar__preview-dot"
                        style={{
                            width: `${Math.max(4, width)}px`,
                            height: `${Math.max(4, width)}px`,
                            backgroundColor: color,
                        }}
                    />
                </div>
            </div>
        </div>
    );
}