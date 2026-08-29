/** The four corner brackets framing every live screencast — a viewfinder
 * reticle, because that's exactly what this is: a live feed being watched. */
export function ViewfinderCorners() {
  return (
    <>
      <span className="vf-corner tl" />
      <span className="vf-corner tr" />
      <span className="vf-corner bl" />
      <span className="vf-corner br" />
    </>
  );
}
