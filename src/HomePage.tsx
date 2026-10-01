import {
  Button,
  Container,
  Flex,
  HStack,
  Heading,
  Input,
  Link,
  List,
  ListItem,
  Text,
} from "@chakra-ui/react";
import { type FormEvent, useState } from "react";

import { pageIdFromOpenInput } from "./pageOpenInput";
import {
  type RecentPageEntry,
  loadRecentPages,
  removeRecentPage,
} from "./recentPages";
import { generateId } from "./useHash";

function formatOpenedAt(openedAt: number): string {
  return new Intl.DateTimeFormat("en-US", {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
  }).format(openedAt);
}

function entryLabel(entry: RecentPageEntry): string {
  const title = entry.title.trim();
  return title === "" ? entry.id : title;
}

function HomePage({ darkMode }: { darkMode: boolean }) {
  const [entries, setEntries] = useState<RecentPageEntry[]>(() =>
    loadRecentPages(),
  );
  const [draft, setDraft] = useState("");
  const [error, setError] = useState("");
  const fieldBg = darkMode ? "#3c3c3c" : "white";

  function refresh() {
    setEntries(loadRecentPages());
  }

  function handleOpen(event: FormEvent) {
    event.preventDefault();
    const pageId = pageIdFromOpenInput(draft);
    if (pageId === null) {
      setError("Enter a page id or a full link containing #page: and the id.");
      return;
    }
    setError("");
    window.location.hash = `page:${pageId}`;
  }

  function handleNewPage() {
    window.location.hash = `page:${generateId()}`;
  }

  function handleRemove(pageId: string) {
    removeRecentPage(pageId);
    refresh();
  }

  return (
    <Flex flex="1" minH={0} overflowY="auto">
      <Container maxW="lg" py={8}>
        <Heading size="lg" mb={6}>
          Home
        </Heading>

        <Flex as="form" direction="column" gap={2} mb={4} onSubmit={handleOpen}>
          <Heading size="sm">Open page</Heading>
          <HStack spacing={2}>
            <Input
              aria-label="Open page"
              value={draft}
              placeholder="Page id or link"
              autoComplete="off"
              bgColor={fieldBg}
              borderColor={darkMode ? "#3c3c3c" : undefined}
              color={darkMode ? "white" : undefined}
              onChange={(event) => {
                setDraft(event.target.value);
                setError("");
              }}
            />
            <Button type="submit" colorScheme="blue" flexShrink={0}>
              Open
            </Button>
          </HStack>
          {error !== "" && (
            <Text
              role="alert"
              fontSize="sm"
              color={darkMode ? "red.300" : "red.600"}
            >
              {error}
            </Text>
          )}
        </Flex>

        <Button variant="outline" mb={8} onClick={handleNewPage}>
          New page
        </Button>

        <Heading size="sm" mb={3}>
          Recent pages
        </Heading>
        {entries.length === 0 ? (
          <Text color={darkMode ? "gray.400" : "gray.600"}>
            No recent pages
          </Text>
        ) : (
          <List spacing={3}>
            {entries.map((entry) => (
              <ListItem key={entry.id}>
                <HStack spacing={3} align="center">
                  <Link
                    href={`#page:${entry.id}`}
                    flex="1"
                    fontWeight="medium"
                    color={darkMode ? "blue.300" : "blue.600"}
                  >
                    {entryLabel(entry)}
                  </Link>
                  <Text
                    as="time"
                    dateTime={new Date(entry.openedAt).toISOString()}
                    fontSize="sm"
                    color={darkMode ? "gray.400" : "gray.600"}
                    flexShrink={0}
                  >
                    {formatOpenedAt(entry.openedAt)}
                  </Text>
                  <Button
                    type="button"
                    size="sm"
                    variant="ghost"
                    flexShrink={0}
                    onClick={() => handleRemove(entry.id)}
                  >
                    Remove from list
                  </Button>
                </HStack>
              </ListItem>
            ))}
          </List>
        )}
      </Container>
    </Flex>
  );
}

export default HomePage;
