"""Image helpers."""

class DownscaleImageToMegapixels:
    CATEGORY = "obvpm/image"
    FUNCTION = "downscale"
    RETURN_TYPES = ("IMAGE",)
    RETURN_NAMES = ("image",)
    DESCRIPTION = (
        "Scales an image down so its total pixel count fits within the given "
        "megapixels, keeping aspect ratio. Only changes the image if it is "
        "larger than megapixels; smaller images pass through untouched. "
        "With no image connected it bypasses (outputs None)."
    )

    OUTPUT_TOOLTIPS = (
        "The image, scaled down if it exceeded the megapixel target. None when no image is connected.",
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "megapixels": ("FLOAT", {
                    "default": 1.0, "min": 0.01, "max": 128.0, "step": 0.01,
                    "tooltip": "Maximum output size in megapixels (1.0 = 1024x1024 pixels). Larger images are scaled down to fit; smaller ones pass through untouched.",
                }),
                "method": (["lanczos", "area", "bicubic", "bilinear", "nearest-exact"], {
                    "default": "lanczos",
                    "tooltip": "Resampling filter used when downscaling.",
                }),
            },
            "optional": {
                "image": ("IMAGE", {
                    "tooltip": "The image to downscale. Leave unconnected to output None (bypass).",
                }),
            },
        }

    def downscale(self, megapixels, method, image=None):
        if image is None:
            return (None,)
        import comfy.utils

        height, width = image.shape[1], image.shape[2]
        target = megapixels * 1024 * 1024
        current = width * height
        if current <= target:
            return (image,)
        scale = (target / current) ** 0.5
        new_width = max(1, round(width * scale))
        new_height = max(1, round(height * scale))
        samples = image.movedim(-1, 1)
        samples = comfy.utils.common_upscale(samples, new_width, new_height, method, "disabled")
        return (samples.movedim(1, -1),)
