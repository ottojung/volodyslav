const API_BASE_URL = "/api";

export const fetchRecentEntries = async (limit = 10) => {
    const response = await fetch(`${API_BASE_URL}/entries?limit=${limit}`);

    if (response.ok) {
        const data = await response.json();
        return data.results || [];
    } else {
        console.warn("Failed to fetch recent entries:", response.status);
        return [];
    }
};

/**
 * Submits a new entry to the API.
 * @param {string} rawInput - The raw input description for the entry.
 * @returns {Promise<Object>} - The API response.
 */
export async function submitEntry(rawInput) {
    const response = await fetch(`${API_BASE_URL}/entries`, {
        method: "POST",
        headers: {
            "Content-Type": "application/json",
        },
        body: JSON.stringify({ rawInput }),
    });

    if (response.status === 201) {
        const result = await response.json();
        if (result.success) {
            return result;
        } else {
            throw new Error(result.error || "API returned unsuccessful response");
        }
    } else {
        let errorMessage = `HTTP ${response.status}`;
        try {
            const errorData = await response.json();
            errorMessage = errorData.error || errorMessage;
        } catch {
            errorMessage = `HTTP ${response.status} ${response.statusText}`;
        }
        throw new Error(errorMessage);
    }
}
