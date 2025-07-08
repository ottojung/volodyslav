import {
    makePhotoStorageError,
    makePhotoConversionError,
    isPhotoStorageError,
} from "../DescriptionEntry/errors.js";
import { storePhotos } from "../DescriptionEntry/photoStorage.js";

/**
 * @typedef {{ blob: Blob; name: string }} Photo
 */

/**
 * Convert photos to base64, store them, and navigate to return URL.
 *
 * @param {Photo[]} photos - The photos to process.
 * @param {string} requestIdentifier - Identifier for the request.
 * @param {string} returnTo - URL to return to after storing photos.
 * @param {(url: string) => void} navigate - Callback to perform navigation.
 * @returns {Promise<void>}
 */
export async function processPhotos(photos, requestIdentifier, returnTo, navigate) {
    const photosData = await Promise.all(
        photos.map(async (photo) => {
            try {
                const base64 = await new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = () => {
                        const result = reader.result;
                        if (typeof result === "string") {
                            const base64Data = result.split(",")[1];
                            resolve(base64Data);
                        } else {
                            reject(
                                makePhotoConversionError(
                                    "FileReader did not return a string",
                                    photo.name
                                )
                            );
                        }
                    };
                    reader.onerror = () =>
                        reject(
                            makePhotoConversionError(
                                "FileReader failed",
                                photo.name,
                                reader.error
                            )
                        );
                    reader.readAsDataURL(photo.blob);
                });

                return {
                    name: photo.name,
                    data: base64,
                    type: photo.blob.type || "image/jpeg",
                };
            } catch (error) {
                throw makePhotoConversionError(
                    `Failed to process photo ${photo.name}`,
                    photo.name,
                    error instanceof Error ? error : new Error(String(error))
                );
            }
        })
    );

    try {
        await storePhotos(`photos_${requestIdentifier}`, photosData);
    } catch (storageError) {
        if (isPhotoStorageError(storageError)) {
            throw storageError;
        }
        throw makePhotoStorageError(
            "Failed to save photos. Please try again.",
            storageError instanceof Error ? storageError : new Error(String(storageError))
        );
    }

    const returnUrl = new URL(returnTo, window.location.origin);
    returnUrl.searchParams.set("from_camera", "true");
    returnUrl.searchParams.set("request_identifier", requestIdentifier);
    navigate(returnUrl.toString());
}
